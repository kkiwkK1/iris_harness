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

### The default was on until 2026-09-06; it is opt-in now, and the asymmetry below is why

> **Overturned 2026-09-06. The periodic sweep defaults OFF** — `pruneVariables`
> is `false` on the plugin schema (b8bd8cd, 3b241f5) and pinned by
> `tests/config-wiring.test.ts` — *the defaults that a reader would guess
> wrong*. b8bd8cd moved the schema default; 3b241f5 stopped `cordis.yml`
> overriding it back to `true`, so the composed app row is `false` too. This
> heading still read "The default is on" until 2026-09-07 — sitting directly
> above the ruling that reversed it. Only the wording is fixed here; no
> reasoning below was removed.
>
> The paragraphs below are kept because their *measurements* stand and the
> asymmetry they describe is exactly what decided it — but their conclusion is
> reversed. The ruling is at the end of this subsection; read it before acting
> on anything here.

~~It defaults **on**, matching upstream, whose `启用: true` reaches every install
through a `.prefault({})`.~~ That is not only a reading of a schema: on the corpus,
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
~~Copying the default is right; copying it while implying the consequences match
would not be.~~

#### The ruling: an opt-out, never a silent opt-in (2026-09-06)

**The paragraph above got the asymmetry right and then drew the wrong
conclusion from it.** "Upstream discards a cache, we discard the only copy" is
not a footnote to copying the default — it is the reason not to. Upstream's
`启用: true` is cheap for upstream *because* `restoreVariables` can rebuild what
it deletes. Nothing here can. A default that deletes unrecoverable state on a
user's behalf has to be something they chose, so `Config.pruneVariables` is
`false` and the periodic sweep runs only for someone who asked for it.

That also settles a contradiction that had been sitting in one file: the schema
said `.default(true)` while its own docstring three lines above said "Off by
default … `@default false`". The docstring was the half nothing pinned, and it
was the half that was right.

**Two consequences to keep straight, because they read like a contradiction:**

- **The `cleanup.offer` still fires on every `chat.open`** while the four gates
  hold, exactly as before and exactly as upstream asks. The offer is not part of
  this switch. A user who wants the space back presses a button and gets it;
  gating the question behind the automatic sweep would turn "we do not delete
  without asking" into "we never ask", which loses the feature instead of the
  data. Pinned by `tests/legacy-cleanup.test.ts` — *cleanup is off by default,
  and the offer is still made*.
- **The divergent shape the old paragraph warned about is real and is accepted.**
  A profile can now hold chats whose early history SillyTavern trimmed and whose
  later history Iris kept whole. That is the arithmetic of two defaults meeting,
  it grows with chat length, and it is the price of not deleting silently. It
  is also self-correcting in the direction that matters: the offer keeps asking,
  and one answer cleans the whole file.

**What would overturn this.** A measurement showing the untrimmed growth is what
users actually hit — chats large enough that the storage, not the deletion, is
the complaint. The reports name the sizes, so that evidence would arrive on its
own rather than needing a census.

### The legacy path: offered, and performed only on an answer

Upstream has a second cleanup that the periodic one does not cover.
`checkAndCleanupLegacyChat` runs unconditionally at init and, behind four gates —
enabled, longer than `keepRecent + 5`, `chat[1].variables[0].stat_data` still
present, and no recorded `ignore_cleanup` — **asks the user**: clean, never ask
again, or export a backup through `/api/chats/export` and then clean. Its action
is a full sweep of `[1, len - 1 - keep]`, far wider than the periodic window.

This host evaluates the same four gates and **asks**, raising a `cleanup.offer`
on every `chat.open` while they hold. It sweeps only on an answer.

For one batch it did no more than report, because the dialog and the backup are
what make this deletion legitimate upstream: performing the sweep without them
would convert a deletion its author requires consent for into a silent one — the
largest single thing this feature can do, done quietly. Both now exist, so the
sequence is upstream’s: ask, back up if asked, then sweep. **A backup that
cannot be written stops the sweep**, because a user who asked for one and did
not get it has not agreed to what was to follow.

**Asked on every open, with no memory of having asked.** Upstream hangs its
check on the chat load itself. Gating the dialog behind a once-per-loaded-entry
note — which is what this did first — turned "we will ask again next time" into
"next time the host loads this entry", so dismissing the dialog and reopening the
chat was indistinguishable from having declined for good. The four gates are the
only memory needed: a swept chat no longer has `stat_data` on its first floor,
and a declined one carries `ignore_cleanup`.

**`ignore_cleanup` is upstream's key *at upstream's position*.** A refusal is
written to the literal `chat[1].variables[0]` — the row's own table, not the
card-facing projection of it — so a chat moved between the two hosts carries the
answer its owner gave. **For one batch this was written to message 2 instead**,
through the §14 mapping, and the claim above was therefore false in both
directions: upstream reads `chat[1]` and would have asked again, and a chat
arriving from SillyTavern would have been asked again here. Copying the key’s
name buys nothing without copying its address.

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

## 10. Script injections are held per frame run, where upstream holds one global set

Upstream keeps `extension_prompts` in a single module-level object
(`script.js:625`) and `clearChat()` empties it — 14 call sites covering opening,
switching and deleting a chat. Nothing serialises it, so a reload loses it too.
This host keeps injections **on the frame run that made them**, which agrees with
upstream on the part that matters most — they are memory-only and never
persisted, because an injection belongs to a running script — and reaches the
same outcome by attribution rather than by emptying a table: the shell says when
a run ends, and that run's injections go with it.

**For most of this feature's life they were held per *chat***, and switching away
and back found them still there. The paragraphs below are the argument that led
to that, and they are kept because the argument was right about the thing it was
about — see the consequences section for what measurement then settled.

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

That `settings.json` has a **second reader** since 2026-09-07: §21, the one-time
seed of a new profile's world-info scan knobs. Same file, same read-only
promise, different question — and the reason it is a separate entry is that
fetching a book a card already names is compatibility, while adopting the
user's knobs is a migration convenience.

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
`notes/apps/iris-web/UPSTREAM-FRAME-ORIGIN.md` §六.

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

## 18. An image with no card inside imports as an empty character

**The rule:** a PNG that parses but carries no `chara`/`ccv3` chunk (the corpus
shape: an SD generation whose only text chunk is `parameters`) and any JPEG
with a valid SOI marker import as **empty characters** — every field blank, the
picture itself the avatar, the id and display name minted from the filename.
`packages/iris-app-service/src/library.ts` (`decode`) is the single place the
rule lives; the avatar route gained `image/jpeg` and the web picker gained
`.jpg,.jpeg` in its `accept` list, both consequences of the same row.

**Upstream does not do this on the import path — both shapes are refused
there, and that was verified against the install, not remembered.** Live probe
of `E:/sillyTavern/SillyTavern` (1.18.0, `51ad27fb8`, no plugins installed),
driving `/api/characters/import` exactly as the client does:

| corpus file | upstream's answer |
| --- | --- |
| `00004-4209168235_1.png` | `200 {"error":true}` — the client toastr reads *"The file is likely invalid or corrupted. / Could not import character"* |
| `00043-409781020.png` | `200 {"error":true}` — same |
| `liwy.jpg` | never reaches the server: `importCharacter`'s extension gate (`json, png, yaml, yml, charx, byaf`) drops it **silently**; forced through anyway, the server answers `{"error":true}` (`Unsupported format`) |
| the six real cards | imported, named from the card — the listing matches Iris's field for field |

The PNG half comes from `src/character-card-parser.js`: `read()` throws
`'No PNG metadata.'` once `textChunks` holds no `ccv3`/`chara` keyword — a
`parameters` chunk keeps it off the *first* throw but not the second. The JPEG
half is the client gate at `public/script.js` (`importCharacter`), mirrored by
the server's `formatImportFunctions` map, which has no `jpg` arm.

**So why accept? The one upstream surface that does take these files.** ST's
character creator uploads any image as the avatar (multer takes whatever the
browser posts; Jimp re-encodes it to a 400x600 PNG), producing exactly what this
row produces: a character with empty fields whose picture is the image. The
user's acceptance claim — *all nine corpus files open as characters in my
SillyTavern* — is that surface seen from the front; the task set the bar as the
user's observed behaviour, and this row implements it on the import path rather
than asking the user to learn a second door.

**What the divergence costs, measured:**

- **Interop with ST's own folder.** Neither shape survives a round trip through
  ST's characters directory: `/api/characters/all` reads only `*.png` (the
  `.jpg` is invisible) and its `processCharacter` throws on the card-less PNG
  (filtered out of the listing). The bytes are stored as they arrived and can be
  copied back out, but an ST install will not *list* them. A user who needs ST
  to see the character re-saves it from either side's editor, which stamps a
  card into the image.
- **A nameless `.json` is accepted where upstream refuses.** Upstream's
  `importFromJson` returns nothing for a JSON without `name`/`spec`/`char_name`;
  `normalizeCard` lifts it to the same empty body the images get. Left as is:
  it is the same empty-character rule one door earlier, and refusing it would
  split one rule into two extensions. Revisit only with a corpus file that
  makes the laxness cost something.

**What stays a named rejection — the floor did not move for anything upstream
also refuses:** non-image, non-JSON extensions (`.webp`, `.gif`, `.txt`…),
a PNG that fails to parse (bad signature, truncated chunk, CRC mismatch), a
card chunk that is not base64 JSON, `.charx` (still `unsupported`), and bytes
that are not a JPEG at all despite the name. `import-images.test.ts` pins each
arm; the two accepting arms were mutation-tested (remove the empty-card rule or
the extension, watch them go red) so the green is not self-confirming.

**What would overturn this row:** an upstream release that accepts these files
at the import endpoint with a *different* presentation (say, a name from
elsewhere than the filename, or a refusal for SOI-less JPEGs) — then the row
should be re-read against that release, not defended against it.

---

## 19. The global regex layer: the global tier is carried; the preset tier and the allow-gate are not

**Upstream.** `extensions/regex/engine.js` composes three tiers and runs them in
`SCRIPT_TYPES` order — global, then the character's, then the preset's
(`getScriptsByType`: global reads `extension_settings.regex ?? []`, scoped reads
`characters[this_chid].data.extensions.regex_scripts`, preset reads the active
preset file's own `regex_scripts` field). Two gates ride beside them
(`getRegexedString`, `allowedOnly: true`): a character's scripts run only when
its avatar is in `extension_settings.character_allowed_regex`, and a preset's
only when its name is in `preset_allowed_regex[apiId]`.

**Iris.** The profile's global list is stored verbatim at the isomorphic path
(`extension-settings.json`, partition `.regex`) and composed in front of the
card's own on all three directions — storage, display, prompt. Two deliberate
gaps:

- **The preset tier is reserved, not carried.** Upstream writes preset-scoped
  scripts into the preset file; this host's preset library is read-only copies
  (§13 names the read-only install pattern the library keeps to), so there is
  nowhere the tier could live and nothing a panel could edit. `orderScripts`
  already orders the tier, so wiring it later is passing one more list in, not
  reworking call sites.
- **No allow-gate.** Upstream needs `character_allowed_regex` because card
  scripts are untrusted code; this host asks once per card before running any
  script at all (the `scriptsAllowed` consent), which answers the same question
  one level up. Reproducing the regex-specific gate under that consent would
  mean a granted card whose regex silently does nothing until a second,
  better-hidden toggle is found.

**What it costs, measured on this machine's install** (`data/default-user`):
`extension_settings.regex` holds **0 scripts**; `character_allowed_regex` is
**empty**; of the 1 preset file, **0** carry `regex_scripts`. So for this
install: the global tier changes nothing until a user imports into it, the
preset tier has nothing to carry, and the missing gate is the difference
between the two MVU cards' regex working (here) and never running at all
(upstream, as configured). A user moving an install that *uses* the gate would
see card regex switch on — the consent ask is where they would see it named.

**What would overturn this row.** A preset file carrying `regex_scripts` that
a user expects to fire, or a card whose scripts a user wants runnable only
after a per-feature allow — then the tier gets its storage and the gate gets
re-examined against the consent flow, in that order.

## 20. A generation that goes silent is given up on; upstream waits for ever

**Upstream has no timeout on a generation, on either side of its own wire, and
that is a reading of the code rather than an inference.** Its browser calls
`sendOpenAIRequest` with a signal that defaults to `new AbortController()
.signal` (`public/scripts/openai.js:3047`) — a signal nothing ever aborts —
and forwards it verbatim at `:3059`. The only abort that exists is the Stop
button (`script.js:5555`, `abortController.abort('Clicked stop button')`). Its
server then fetches the provider with a bare `AbortController` wired to
`request.socket.on('close')` (`src/endpoints/backends/chat-completions.js
:2531-2535`, signal at `:2585`) and, on two routes, an explicit `timeout: 0`
(`:894`, `:993`; `text-completions.js:331`, `:608`). **Across the whole of
`src/` there is exactly one `AbortSignal.timeout`: 5 s at
`chat-completions.js:130`, on the OpenRouter *model-list* probe** — metadata,
not a generation.

**Why that is sound there and not here.** Upstream's hung request always has a
person and a Stop button at the other end of it, and pressing Stop closes the
socket that the server's abort is wired to. This host serves several pages and
can still be generating for one that was closed an hour ago, so nothing outside
the host is guaranteed to end the silence. Copying upstream here would not be
compatibility; it would be importing the absence of a mechanism upstream gets
from its own topology.

**Iris.** `@iris/llm-openai-compat` runs each call under three budgets, and the
adapter owns them rather than the turn driver — the driver holds only an
`AsyncIterable` and cannot tell "no chunk yet" from "chunk in flight", and
every other consumer (`connection.test`, model probes) needs the same
guarantee.

| phase | default | expires when |
| --- | --- | --- |
| connect | 30 s | no response headers (and no error body) |
| first byte | 120 s | headers arrived, no payload yet |
| idle | 120 s | payloads arrived, then silence |

`0` disables a budget — **not "expire immediately"**, which is the reading that
would hand an operator with a slow local endpoint the opposite of what they
asked for.

**The first-byte budget is the generous one on purpose.** A reasoning model on
a long context legitimately produces nothing for minutes before its first
token, so it is the budget that would manufacture failures if it were tight.
The idle clock measures the *provider's* silence only: it stands down while the
consumer works a payload and re-arms when the host is waiting on the socket
again, because a consumer that hangs is our own defect and dressing it as "the
provider went quiet" points the next reader at the wrong side of the boundary.

One `AbortController` the adapter owns, with timers it can stand down —
**not `AbortSignal.timeout()` composed with `AbortSignal.any()`**. A timeout
signal cannot be disarmed, so the connect budget would keep running underneath
a healthy long stream and kill it on schedule. Being able to end each phase is
the whole mechanism, and `tests/timeouts.test.ts`'s control (*a stream that
keeps talking is left alone*) is what holds it: three tests that all assert
"it gave up" pass equally against an implementation that gives up on
everything.

**The failure is reported as `timeout`, not `provider-error`.** The two ask a
reader for different things — retry, versus go look at the endpoint — and the
provider did not error here, it stopped speaking. The message names the phase
and the elapsed budget because the shell renders it verbatim and never reads
the code. `TIMEOUT` is the harness's own code (already in `dsh-llm`'s default
retryable set), read rather than minted.

**The severity this fixes is not one lost reply.** `ChatEntry.begin()` claims
the chat and only `#settle`/`#fail` release it, and both sit downstream of the
awaited stream — so a silent endpoint left `#abort` set for ever and **every
later send on that chat was refused `busy` until the host restarted**. The
conversation was bricked for the life of the process. Pinned by
`tests/service.test.ts` — *a timed-out turn releases the chat*.

**What it costs.** A provider that legitimately takes longer than a budget is
cut off where SillyTavern would have waited. The report says which budget and
how long, so the answer is a number in the config rather than a mystery — but
the number is ours, and the first user to meet one on a slow self-hosted
endpoint is how we learn whether 120 s is right.

**What would overturn this.** Real endpoints tripping the first-byte budget on
healthy long thinks — the reports would name it, and the fix is per-connection
budgets (a `connection.save` field), which is deliberately not built until
something asks for it.

---

## 21. A profile being created takes its world-info scan knobs from the user's install, once

**Kind: deliberate improvement** (ROADMAP's second ledger), so this entry owes
three things — what is better, what it costs, and why upstream does not do it.
The last one is the easy one: **upstream cannot have this feature, because
upstream is the installation.** `settings.json` is SillyTavern's own state, and
there is nothing for it to import from.

**Upstream, read rather than assumed.** `script.js:7954` calls
`setWorldInfoSettings(settings.world_info_settings ?? settings, data)`, and
that function (`world-info.js:917-943`) assigns each key into a module
variable through `Number()` or `Boolean()`. The `??` is the shape fact worth
copying: a current install nests the family under `world_info_settings`, an
older one keeps it at the top level, and a reader that knows only the nested
shape imports nothing from a pre-migration file while reporting a clean
"nothing to take". The shipped defaults are `world-info.js:69-82` and the
strategy enum — `{evenly: 0, character_first: 1, global_first: 2}` — is
`world-info.js:27-31`.

**Iris.** When a profile's `settings.json` is **created** — not on any later
boot — and the composition has a `sillyTavernDir`, the install's
`world_info_*` family is read and the knobs this host models are stored as that
profile's starting values (`src/st-install.ts` `worldInfoSettings`,
`src/worldbook-settings.ts` `importWorldbookSettings`, `src/settings.ts`
`seedWorldbookSettings`, wired at `src/index.ts` right after `settings.load()`).

**What is modelled, and what is therefore imported.** All twelve fields of
`WorldbookSettings` have an ST key, and `IMPORTED_WORLDBOOK_KEYS` is asserted
against `DEFAULT_WORLDBOOK_SETTINGS` so a knob added to the model without a key
cannot pass silently:

| ST key | this host's field | note |
| --- | --- | --- |
| `world_info_depth` | `scanDepth` | |
| `world_info_budget` | `budgetPercent` | |
| `world_info_budget_cap` | `budgetCap` | |
| `world_info_min_activations` | `minActivations` | |
| `world_info_min_activations_depth_max` | `minActivationsDepthMax` | |
| `world_info_max_recursion_steps` | `maxRecursionSteps` | |
| `world_info_recursive` | `recursive` | |
| `world_info_case_sensitive` | `caseSensitive` | |
| `world_info_match_whole_words` | `matchWholeWords` | |
| `world_info_use_group_scoring` | `useGroupScoring` | |
| `world_info_include_names` | `includeNames` | ST default `true`; the reference install runs `false` |
| `world_info_character_strategy` | `insertionStrategy` | **`0 \| 1 \| 2` upstream, a word here** — the one key that is translated, not copied |

Not imported, and each for its own reason:

- **`world_info_overflow_alert`** — not modelled. There is no field to put it
  in (§ the module docstring: a UI notice this host has no surface for), and
  inventing storage for a setting nothing reads would make the import look more
  complete than the host is. It keeps riding the card-facing
  `LorebookSettings` table with ST's default, as before.
- **`world_info.globalSelect`** — modelled, and still not imported. It is a
  *selection*, not a knob: adopting it would make this host's prompts depend on
  what the other application happens to have selected right now.
  `SettingsStore.setGlobalSelect`'s docstring is the standing decision and this
  did not reverse it.

**What it buys, measured on the reference install.** Fourteen keys sit under
`world_info_settings` there, and **three of the twelve importable ones disagree
with this host's defaults**: `world_info_budget` is `100` against a default of
`25`, `world_info_include_names` is `false` against `true`, and
`world_info_recursive` is `true` against `false`. So the seed is not cosmetic on
a real machine — without it, a book tuned in SillyTavern under a 100 %
budget with recursion on would under-fire here on its first day, which is
exactly the class of surprise `worldbook-settings.ts` was written to end. The
other nine agree, which is worth saying plainly: the feature's value on this
one install is three knobs, not twelve.

**A seed, never a sync, and the property is structural.** `seedWorldbookSettings`
takes a *callback*, and an existing profile never calls it — the install's
`settings.json` is not even opened. Passing an already-read import would have
made "we do not re-read another application's settings" depend on the caller
checking first, which is the kind of ordering that survives review and dies in
a refactor. The same tri-state (`#found` is `undefined` until `load` has run)
makes a seed attempted before `load` a no-op rather than a write over settings
this store has not read.

**Stricter than upstream on values, deliberately.** `Number('deep')` is `NaN`
and `Boolean('false')` is `true`; upstream survives that because its result is a
module variable the next settings write replaces. Here the value is *stored into
a profile*, so a `NaN` scan depth would outlive the mistake and every later read
would inherit it. A key whose shape is wrong falls back to that key's own
default and produces a sentence on the host log; the other keys still import.
Whole-file failures (no `settings.json`, unparsable, not an object) report one
line and leave the whole table at ST's defaults — "could not read it" and "the
user runs the defaults" produce identical knobs and are different facts.

**What it costs.**

1. **A silent success.** Only failures reach the log, so a user whose profile
   was seeded has no line saying so — the knobs simply are what their install
   said. That is the same shape as the pre-profile-layout warning being the only
   thing that speaks, and it is a real gap: the fix is a settings panel that
   shows provenance, not a boot line nobody reads.
2. **Day-two drift with no notice.** After the first boot the two applications
   are independent. A user who then retunes SillyTavern and expects Iris to
   follow will not be told otherwise.
3. **An oddly configured install becomes an oddly configured profile.** The
   seed copies the user's own choices, including ones they had forgotten making.

**What would overturn it.** A user who wants the two kept in step — i.e. asks
for the sync this deliberately is not. The answer then is an explicit
"re-import from SillyTavern" action, not a per-boot read: a host that silently
re-adopted another application's settings would undo the user's own edits here,
which is the one outcome this shape exists to prevent.

**Pinned by** `tests/st-settings-import.test.ts` (15 tests): the twelve-key
import including the numeric strategy translation, the per-key fallback with its
three report lines, the unmodelled key appearing in neither the file nor the
reports, the second start neither re-reading nor overwriting, the seed-before-load
no-op, the three whole-file failures each with their own sentence, the flat
pre-migration layout, that nothing writes to the install, and — structurally,
in the manner of `config-wiring.test.ts` — that the composition calls the seed
**after** `load`, since getting that order wrong disables the migration without
a red test or a log line.

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

## The "never cleaned" report line comes back after a restart

**This is about the report line, not the dialog** — they are two different
things at the same moment and only one of them is rationed. The `cleanup.offer`
that raises the three-button prompt fires on **every** `chat.open` while the
gates hold, which is when upstream asks; that is not a bug either, and the
reasoning is in section 8.

The **report line** that records the same fact for the diagnostics view says
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

## Generation kinds: a continue closes with the nudge, not the wrap-up

`chat.send` grew `kind: 'continue' | 'impersonate'` (the implementation plan's
B2), and three readings of upstream's continue/impersonate are deliberately
ours. Upstream source for all three: `public/scripts/openai.js` and
`public/scripts/PromptManager.js` at tag `1.18.0`.

**A continue drops the post-history section entirely.** Upstream keeps
post-history instructions in a continue's prompt and splices the continued
message past them (`openai.js:898` moves the last message plus the nudge to the
end of the assembled prompt). Here the section is omitted instead
(`resolvePreset` refuses everything after the history marker for
`generationType: 'continue'`): its content is wrap-up instruction — telling the
model how to *finish* a reply is exactly wrong when the request asks it to
write on from one. Anyone diffing the two prompts side by side will see the
difference; the preset's `injection_trigger` lists still apply first, so an
item excluded by trigger on a normal send is not resurrected by this rule.

**The continue result is a new reading, not an in-place edit.** Upstream's
continue appends the model's words to `chat[last].mes` and rewrites the current
swipe entry. Here the joined text (seed + continuation) is appended as a new
candidate of the same turn, so every earlier reading stays swipable — the
acceptance for B2 names swipe history as the thing to keep, and an in-place
rewrite would spend it. The file projection is identical in shape
(`swipes[]` grows by one, `swipe_id` points at the joined reading).

**An impersonation records nothing and stores verbatim.** The generated text
becomes a user line — no variable table is written for its turn (a user line
carries no variable consequences, the same rule a typed message lives under;
upstream's MVU processes impersonated text like any other message, so a card
that expected a user-side fold will not see one here), the chat's
storage-direction regex does not run on it (those scripts shape what the *user
typed*), and no `assistant/chunk` journal is kept for the generation, because
the text is not an assistant message and never replays as one. A partial
impersonation kept on abort becomes the partial user line; a provider failure
keeps nothing at all, because half a sentence in the user's mouth is not a
reply the user can retry.

Two upstream affordances are absent rather than changed: the nudge and the
impersonation prompt are the shipped defaults (`openai.js:104-110`), because
this host has no settings surface for them yet — `{{lastChatMessage}}` in the
nudge is still substituted, so lifting them into settings later is additive.
And a continue on a chat whose newest line is a user line (an exchange that
never got its reply) is refused by name, where upstream would continue the
user's text: the log can only extend a turn through candidates, which are
assistant messages, and replying-as-the-character to a continue request would
have looked identical from the outside while being a different operation.

## Host

**`GET /version` answers `pkgVersion: "1.18.0"` — SillyTavern's version, not
Iris's.** Upstream's route (`src/server-main.js:272` → `getVersion`,
`src/util.js:136-164`) returns `{agent, pkgVersion, gitRevision, gitBranch,
commitDate, isLatest}`, and cards read `pkgVersion` to ask **which behaviour
set they are talking to**. The honest answer to that question is the version of
the behaviour set, which is the release this host reproduces. **What the user
sees:** a host that reports itself as SillyTavern 1.18.0, which reads as Iris
pretending to be something else. **Not fixed because** the alternative is worse
*and* less true: MagVarUpdate opens with
`fetch('/version').then(e => e.json()).then(e => e.pkgVersion).catch(() => '1.0.0')`,
so reporting `0.1.0` — or not answering at all, which was the state until now
and cost two red reports per MVU card per chat — pushes every version-gated
card onto a branch written for a SillyTavern older than any that shipped. A
card asking whether `getCharWorldbookNames` exists gets a right answer from
`1.18.0` and a wrong one from `0.1.0`.

Nothing is concealed by it: the payload carries an extra `iris: {version}`
field upstream has no equivalent for, so "which host is this" has its own
answer rather than being crammed into the field that answers a different
question. Two divergences inside the reproduction, both deliberate:

- **`agent` keeps upstream's shape but not its maintainer.** Upstream's literal
  is `SillyTavern:${pkgVersion}:Cohee#1207`; this host sends
  `SillyTavern:1.18.0:Iris`. That string exists to identify a client to the
  **Horde API** — reproducing a version number states which behaviour we
  implement, while reproducing a named person's handle in a string built to be
  sent to a third party is a different act, and nothing here talks to the Horde.
  Measured **0 reads** of this field across the fetched bundles, so the
  substitution costs no observed consumer.
- **The three git fields are `null` and `isLatest` is `true`.** Not invented:
  that is precisely what upstream returns when `git` is absent (`util.js:159`'s
  catch leaves them at their initial values), which is what a release-zip
  install reports.

**What would overturn this.** A card that branches on `agent`'s third segment,
or one that treats `pkgVersion` as "which program" rather than "which
behaviour" — the second would show up as a card refusing to run at all rather
than degrading.

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


## 世界书机制补全（2026-09-04，任务 L）——三处向 ST 真值回归的修正，一处实测发现

本节记录的是**对本仓既有行为的修正**，不是对上游的偏离；写在这里是因为三处都改变了
已经跑过的路径上的可观察行为，读旧日志的人需要知道分界线。

**一、扫描默认 `matchWholeWords` 从 `true` 改回 ST 的 `false`。** 引擎
（`defaultActivationSettings`）与直呼 `matchKey` 的缺省曾是 `true`，而卡面
`getLorebookSettings()` 一直报上游默认 `false`——同一台机器上两层对同一个设置给出
相反答案，书是按 ST 调的，条目在此静默欠触发。现在存档设置是唯一真值，引擎、卡面、
面板三方读同一张表，缺省与上游一致（`world-info.js:69-82`）。**行为变化**：以前靠
整词边界挡住的误触发会回来，这是上游行为，不是回归。

**二、世界书扫描设置成为真实存储。** 此前引擎跑死缺省、卡面报上游缺省、面板不存在，
`world_info_budget_cap` 完全不生效（预算恒为 contextWindow × 25% 的硬编码份额）。
现在 `settings.json` 的 `worldbooks` 节持有全部扫描旋钮，经 `worldbook.settings` /
`worldbook.setSettings` 读写，`computeBudget` 落预算与上限。**顺带修掉一个存储缺陷**：
`SettingsStore.load()` 重建文件态时丢弃 `worldbooks` 节，全局选择只在进程内存里活着，
一次重启即静默清空——`tests/worldbook-settings.test.ts` 钉住。

**三、插入顺序按 `getSortedEntries` 全量对齐。** 旧实现把角色书与全局书拼成一张表后
做**单次** `order` 降序排序（外加 uid 决胜）——既不是 `character_first` 也不是
`evenly`，是任何上游值都产不出的第三种顺序：全局书里 order 更高的条目会插到角色条目前面。
现按上游三分支逐一转写：`character_first`/`global_first` 先组内排序再拼接（整组相续），
`evenly` 拼接后排序（并列归先拼接的一方，上游数组顺序是全局在前），去掉 uid 决胜改用
稳定排序。同书内并列的次序来自文件的键序，与上游读 `Object.keys` 的次序一致。

**实测发现（未改，待裁）：新近一条用户消息在本卡上不进扫描窗。** 哈人冰恋世界
（107 条目书）实测：首条用户消息含关键词（如「历史」）时不触发，第二条用户消息进入
后（关键词落到深度 ≥1）触发正常。成因不是激活引擎——同一本书、同一个键直呼引擎
2 条即中——而是 `#history` 先跑卡面 prompt 正则再给扫描（既定裁决「扫描不匹配正则
即将剥掉的块」），而该卡的 prompt 正则恰好把最新一条用户输入从提示词里剥掉（其玩法
就是首楼输入被界面吃掉）。ST 扫的是未过正则的原文，此处是 Iris 既有的投影裁决在此卡
上的可见代价；是否改为「世界书扫原文」属跨任务裁定，未动。

---

## 22. What the provider charged is recorded per generation; upstream records only its own estimate

**Kind: deliberate improvement** (ROADMAP's second ledger), so this entry owes
three things — what is better, what it costs, and why upstream does not do it.

**Upstream, read rather than assumed.** SillyTavern records a token count per
message and it is **its own estimate of the message text**, not anything the
provider said:

| what | where |
| --- | --- |
| the number stored | `public/script.js:5830`, `:6629`, `:6654`, `:6676`, `:6705`, `:10242`, `:10945` — `message.extra.token_count = await getTokenCountAsync(tokenCountText, 0)` |
| gated on a display switch | the same lines, each under `if (power_user.message_token_count_enabled)` |
| whose default is off | `public/scripts/power-user.js:199` — `message_token_count_enabled: false` |
| where it is shown | `public/script.js:2585` — `const tokenCount = mes.extra?.token_count` |
| archived per swipe | `public/script.js:6738`, `:6748` — `extra: structuredClone(item.extra)` into `swipe_info[i]`, with `token_count` deliberately deleted for freshly arrived swipes (`:6754`, `:3706`) |

**And the provider's own report is never read.** `prompt_tokens` appears in
`public/` exactly once, as a CSS class in the prompt manager
(`PromptManager.js:1761`, showing *calculated* tokens); `usage` does not appear
in `public/scripts/openai.js` at all, and the chat-completions backend
(`src/endpoints/backends/chat-completions.js`) passes the response through
without reading it. So upstream cannot show a cache-hit share for any provider:
the number is in every response it receives and nothing looks at it.

**Iris.** The `usage` chunk is kept whole. It is attached to the **candidate**
the generation produced (`iris/usage`, keyed by `candidateSeq` exactly as
`iris/variables` is), projected onto `MessageView.usage` for the selected
candidate and summed over every candidate for `ChatView.usage`, and carried in
the chat file so it survives a restart. `src/usage.ts`, `src/entry.ts`
(`noteUsage` / `recordUsage` / `hydrateUsage` / `toFile`), `src/views.ts`,
`tests/usage-record.test.ts`.

**Where it is stored, and why not in `extra`.** A **top-level** `iris_usage`
key on the message line, an array parallel to `swipes` — the same positional
shape this file format already uses for per-swipe variable tables. `extra` was
the obvious choice and is measurably wrong: SillyTavern treats `extra` as
per-swipe state it swaps wholesale, assigning
`targetMessage.extra = structuredClone(targetSwipeInfo?.extra) ?? {}` on every
swipe (`public/script.js:6956`) from a copy archived when the reply landed
(`:6738`). One swipe in SillyTavern would therefore delete an array parked
there, and a single object parked there would need `swipe_info` entries this
host does not model. Upstream's core touches no other top-level key on that
swap, so a parallel array survives a trip through an install that has never
heard of Iris.

**`extra.token_count` is neither read nor written.** It answers a different
question (upstream's estimate of the text) by a different measurer, it is
already in the user's files, and it is what upstream's own UI shows. Ours is
what the provider charged for the request. Confusing the two would put a
plausible number in the wrong place; `tests/usage-record.test.ts` asserts the
field comes back byte-identical after a record-and-export.

**What it costs.**

- **Storage**: one array per generated reply, `null` for a swipe whose provider
  said nothing. A full record is six small integers — about 90 bytes of JSON
  per swipe. A line that has no record gets no key at all, so a chat played
  through an endpoint that reports no usage is byte-identical to before.
- **Coverage**: **only where the provider reports it.** Nothing is estimated
  and nothing is back-filled — an imported SillyTavern history, and every chat
  this host generated before this existed, carries no figures and never will.
  A surface must render that absence as nothing rather than as zeros, which is
  why no bucket is ever zero-filled (`TurnUsage`, and `sumUsage`'s rule).
- **Two generations are not counted.** An impersonation costs tokens and has no
  candidate to hang them on (its text becomes a *user* line), so its cost is
  dropped rather than parked on a neighbouring reply. A generation that failed
  or was aborted before the `usage` chunk arrived records nothing, which is
  correct — no candidate settled either.
- **One residual, inherited rather than added.** Deleting a swipe **in
  SillyTavern** splices `swipes` and `swipe_info` and knows nothing about
  parallel arrays, so the array is left one entry too long and shifted. That is
  the same residual `variables` already carries in the same file for the same
  reason; a surplus entry is dropped with a report on the next open rather than
  reattached to the wrong swipe.

**One shape decision, ruled after the first cut and worth recording as its
own line.** `ChatView.usage` — the conversation aggregate — carries **no
`totalTokens`**. Summed under the optional-bucket rule it would cover only the
generations that reported an exact total, so on a conversation that mixed
providers it comes out *smaller* than the buckets printed beside it (measured
on the fake's seed: 5712 against 6064 + 826) while still reading as "the
total". A conversation therefore reports the four buckets, and a reader wanting
one figure adds the ones it is showing. One generation keeps its own
`totalTokens`, where the provider's aggregate means exactly what it says. The
split lives in `conversationUsage` (host) and its twin in `@iris/client-fake`,
with the rule written on `ChatView.usage` in the protocol.
## 23. A probe may be asked to use the key the host already holds — bounded by the endpoint's origin

**Kind: compatibility gap, closed** (the key half) **plus one deliberate improvement** (the per-conversation model, and the host's own connection as a readable row).

**The report** (user, 2026-09-07): 「每次测试连接都要重新填一次 apikey，众所周知 apikey 在绝大多数平台都是只能看到一次」.

**Upstream, read rather than assumed.** SillyTavern's key never travels back to the page either: `/api/secrets/write` stores it and `/api/secrets/read` answers with a presence map (`secrets.js`, `SECRET_KEYS` / `writeSecret` / `secretState`), which is why its connection panel shows a masked "saved" state and its **Connect** button — `getStatusOpen`, which is the same `/models` fetch this host's probe is — works with the field left empty. So "test with the key you already have" is upstream behaviour, and the gap was on this side: `connection.test` had no way of being *asked* for it. The panel sent `{ baseURL, apiKey }` from the form, and an empty field meant an empty key.

**Iris, now.** `connection.test`'s `apiKey` is optional as a **request**: absent or empty asks the host to probe with what it holds. `#probeCredential` resolves it as a precedence of decisions, newest first —

1. the key in the request (the user has just typed it) → `keySource: 'typed'`;
2. the named profile's stored key → `'stored'`;
3. the **active** profile's stored key, which is what makes an untouched form testable → `'stored'`;
4. the credential the host process was started with → `'host'`;
5. nothing, which a local serve is happy with → `'none'`.

`keySource` is on **every** verdict, including the `missing-key` and `no-endpoint` refusals that never reach a socket, and the type is built so it cannot be forgotten: `#probeEndpoint` returns `Omit<RpcResponse<'connection.test'>, 'keySource'>`, so the one place that resolved the credential is the only place that can name it.

**Steps 2–4 are each gated on `sameEndpointOrigin`, and that gate is the point of this entry.** Without it, an absent `apiKey` would be an instruction the browser could give: probe *this* address, using a credential you will not show me. The page cannot read the key; it could still spend it, at an endpoint of its choosing, and the response would even report the latency of the exfiltration. A key is therefore reused **only at the origin it belongs to** — anywhere else the probe goes out bare and says `'none'`, which the panel renders with the missing-key sentence it already had. `tests/connections.test.ts` asserts the useful direction (a saved profile re-tests with nothing typed) and the bounded one (the same absent key at a foreign origin selects nothing), and the second assertion was verified to go red when the origin comparison is replaced by `true` — the useful half stays green under that mutation, which is exactly why the pair is written rather than the first alone.

**Two things ride along, and are improvements rather than gaps.**

**(a) The host describes its own connection.** `connection.list` now answers with `host?: HostDefaultConnection` — provider, endpoint, model, and the *source* of its key plus the **name** of the variable holding it, never the key. Upstream cannot have this: upstream *is* the installation, and there is no environment-configured route behind its panel to describe. A host started from `IRIS_BASE_URL` / `IRIS_MODEL` / `IRIS_API_KEY_ENV` used to be reported by the panel as "no active connection" — true of the profile list, and useless as a report, because the thing answering the user was right there and unnamed. `connection.save`'s new `adoptHostKey` turns that row into an editable profile with the credential copied **inside the process**; the browser names a key it has never been shown. It is ignored where the host holds no credential, and outranked by a typed key (a flag set when the form opened is the older of the two decisions).

**(b) `settings.get` / `settings.set` answer with `overrides`.** The chat override layer has always existed (`SettingsFile.chats[chatId]`, `null` clears one field of it); what did not exist was any way to *read* it. The merged value cannot distinguish a conversation's own choice from the default showing through — a chat overriding `model` with the string the global layer already carried is byte-identical, merged, to one overriding nothing — and an interface offering to undo the choice needs the difference. `SettingsStore.overrides(chatId)` exposes the layer, and **presence is scope**: the field is present exactly when the request named a `chatId`, where `{}` is the real answer "overrides nothing" and absent means the global layer, which is the bottom and has nothing to override.

**A coupling this entry admits.** The `hostConnection` option is what the composition *should* hand in, and the shipped `apps/iris/cordis.yml` does not: its `app` row carries `provider` and `model` but no endpoint and no key variable. So `hostConnectionFromEnv` reads the same three variables the composition's own `llm-openai-compat` row reads, as a fallback, and an explicit option always wins. That makes it a second **reader** of one decision rather than a second decision — but only as long as the names agree, so `HOST_CONNECTION_ENV` names them in one place and `tests/host-connection.test.ts` parses `cordis.yml` and fails when a name there stops appearing. Reaching from a package test up into `apps/iris/` is a layering inversion and the deliberate price of the guard: the alternative is a comment, and a comment does not go red. **Wiring the option properly in `packages/iris-app-service/src/index.ts` and the composition row is the follow-up this entry leaves open**, and doing it would let the fallback be deleted.

**What it costs.**

- **Origin, not the full URL.** `…/v1` and `…/v1beta/openai` on one host are treated as one credential holder. A single origin serving two tenants under different keys would have the first key offered for the second path. Nothing in play does that, and the stricter rule — a character-identical base URL — would refuse to reuse a key the user plainly meant, which is the failure this entry exists to remove.
- **A profile now stores something the user did not type.** `models` + `modelsProbedAt`, filed by a successful probe of a *named* profile, so a picker elsewhere has a list without opening the connection form. This module's opening rule is that nothing **derived** is stored, and this is not derived — it is an observation, and it ships with the moment it was made so it cannot pass as current truth. It is dropped whenever `baseURL` moves: those names are another server's answer, not a stale version of this one's. A failed probe records nothing, because an empty list would be the claim "this endpoint offers nothing".
- **`process.env` is read from inside this package**, through an injectable option that tests always pass (`env`), which is the only reason the suite is deterministic. Left to the default, an assertion about the host row would depend on whoever ran it having `IRIS_BASE_URL` exported.
- `keySource` is one more field a client can misread. `'stored'` and `'host'` both mean "you did not type this" and a panel that treated them alike would tell a user their *profile* works when what answered was the host's environment key. The distinction is in the protocol precisely so the sentence can differ.

**What would overturn it.** A per-path credential model at one origin, which would make the origin check too coarse. Or an endpoint whose `/models` needs a scope the generation key lacks, which would make the recorded-list machinery reliably empty and put the weight back on the typed model name.

## 24. A reroll was showing the model the reply it was being asked to replace

**Kind: compatibility gap, closed.**

**Found by measurement, not by report.** The cache-prefix round (`CACHE-PREFIX.md`, 2026-09-07) went looking for why adjacent turns share less prefix than they should and found this on the way: `historyFromSession` projected **every** derived message, and `driver.regenerate` asked for that projection unchanged, so a regeneration's request ended with the candidate it was about to overwrite.

**Upstream drops it on both of its paths**, and they are different mechanisms with the same outcome:

- **regenerate** — `Generate` deletes the message from `chat` *before* the prompt is built: `deleteItemizedPromptForMessage(chat.length - 1); chat.length = chat.length - 1; await removeLastMessage()` (`public/script.js:4344-4352`). The reply is gone from the log, not merely from the request.
- **swipe** — the message stays on the log and is popped from the prompt copy only: `if (type === 'swipe') { coreChat.pop() }` (`public/script.js:4438-4440`).

Either way the conversation the model reads ends at the user's line. **Iris's swipe-to-generate is `regenerate`** (`swipe()` only chooses among candidates that already exist), so the two upstream paths meet here as one, and Iris takes the swipe mechanism for both: the candidate stays a swipe on the log, and only the prompt leaves it out. That is the deliberate half of this entry — upstream's regenerate really does destroy the reading, and destroying it here would take its `iris_usage` row and its variable table with it.

**Upstream's guard is transcribed with it.** The branch above does nothing when the newest message is a user line (`if (chat.length && lastMessage.is_user)`), which is exactly the retry case: a turn whose first attempt failed has a user line and no candidate, and there is nothing to leave out. So the rule is "drop a trailing **assistant** entry", not "drop the last entry" — `HistoryProjection.dropTrailingReply`, honoured in `historyFromSession`.

**Where the decision lives, and why it is enforced twice.** The driver decides (`regenerate` passes `{ dropTrailingReply: true }`) and the `history` callback is asked to honour it. `IrisAppService.#history` does honour it, and that matters for a reason beyond tidiness: the prompt-direction regex scripts are given a `depth` computed over what that function returns, and upstream's depths are counted **after** the pop (`coreChat.length - index - 1`, `public/script.js:4444`), so a script scoped to the newest message must land on the user's line during a reroll. But `TurnDriverOptions.history` is a callback, and the obvious way to write one — `session => historyFromSession(session)` — cannot honour anything; three call sites in this repository are spelled that way. So `projectedHistory` in the driver checks the answer: a projection that came back the same length the log derives is repaired, one that came back shorter is left alone. A parity rule a caller opts out of by writing the natural thing is not a parity rule.

**The world-info scan and the itemization move with the request.** `#contributions` builds the scan buffer and the recorded itemization from the same projection, because upstream's scan reads `coreChat` after the pop and its itemization is an account of what was really sent. Without that, a reroll could fire a world-info entry on a keyword that exists only in the text nobody is sending.

**What it costs.**

- **Nothing on the send path**, deliberately: `send`, `continue` and `impersonate` pass no projection. A continue must see the reading it is writing on from — dropping it would turn the request into a bare reroll carrying a continue nudge.
- **A reroll's request is now byte-identical to the send it rerolls** (asserted, `tests/prompt-fingerprint.test.ts`), which is the best possible cache outcome and also a second, independent reading of the change: an identical prompt hash is only possible if the candidate is absent.
- **The preview does not drop anything.** `prompt.itemize` with no record previews *the next send*, not a reroll of the newest turn. A user who opens the panel and then presses reroll sees a preview one message longer than the request that follows.
- **`apps/**` was out of this round's write scope**, so the demo driver and two app-level tests still pass a projection-blind `history` callback. They are correct because of the driver's repair, not because of their own spelling — and the repair is what makes that acceptable rather than a second behaviour.

**What would overturn it.** A generation kind that must see the newest reply *and* replace it (a "rewrite this reply" mode would be one), which would need the projection to name what to drop rather than answering yes or no.

## 25. `before` and `after` injections were placed after every preset section instead of beside the main prompt

**Kind: compatibility gap, closed.**

**What a card asks for.** `script.setExtensionPrompt` is upstream's `setExtensionPrompt`, and its positions are `extension_prompt_types` (`public/script.js:483-488`): `BEFORE_PROMPT: 2` → `'before'`, `IN_PROMPT: 0` → `'after'`, `IN_CHAT: 1` → `'at-depth'`, `NONE: -1` → `'none'`.

**Where upstream puts them — read, not assumed.** `getPromptPosition` turns `BEFORE_PROMPT` into the string `'start'` and `IN_PROMPT` into `'end'` (`public/scripts/openai.js:1131-1140`). The **only** consumer of those two words is `injectToMain`, which inserts the message into the *main prompt's own collection*: `chatCompletion.insert(message, 'main', position)`, where `'start'` unshifts and `'end'` pushes (`openai.js:1256-1300`, and `insert` at `openai.js:3940-3960`). A card's injection therefore sits **immediately before or immediately after the `main` prompt** — near the top of the request in any ordinary prompt order, not at the end of anything.

The order table, before and after:

| position | upstream | Iris before | Iris now |
| --- | --- | --- | --- |
| `'before'` (`BEFORE_PROMPT`) | unshifted into main's collection — directly ahead of the main prompt | `{ kind: 'system', order: 850 }` — behind every preset section (they are 10, 20, 30 …, `chat-completion.ts:249`), ahead only of the author's-note bucket at 900 | `{ kind: 'system', order: mainOrder - 1 }` |
| `'after'` (`IN_PROMPT`) | pushed into main's collection — directly behind the main prompt | `{ kind: 'system', order: 950 }` — behind everything, including the author's note | `{ kind: 'system', order: mainOrder + 1 }` |
| `'at-depth'` (`IN_CHAT`) | `getExtensionPrompt(IN_CHAT, …)` inside the conversation | depth injection | unchanged |
| `'none'` (`NONE`) | queried by no call site | no placement | unchanged |

`mainOrder` is read off the resolved contributions (`mainPlacement`), not off the preset file: `resolvePreset` numbers items by their position among the ones that *rendered*, so the number moves when a user enables or disables a prompt. `±1` rather than main's own order because this pipeline sorts by `(order, sequence)` and injections are appended after the preset's contributions — upstream keeps the same order bucket and relies on array position, which is not expressible here.

**The preset's own order needed no change, and that was worth checking.** Upstream's default `prompt_order` (`default/content/settings.json:540-588`, the legacy `character_id: 100000` group) is main → worldInfoBefore → charDescription → charPersonality → scenario → enhanceDefinitions (disabled) → nsfw → worldInfoAfter → dialogueExamples → chatHistory → jailbreak. `DEFAULT_PRESET` agrees with that sequence for every marker both carry; it ships no `nsfw` and no `enhanceDefinitions` (upstream's `nsfw` carries opinionated content, and this default is deliberately a skeleton), and it gives `personaDescription` a slot at position 3, where upstream's default order has none at all — upstream pushes that prompt into the collection and, finding no marker to replace, appends it (`openai.js:1424-1484`). The persona's placement is `UPSTREAM-PERSONA.md`'s subject and is left to it.

**Two upstream branches, both mirrored.** When `main` is itself an in-chat (absolute) injection, `injectToMain` falls through to copying main's depth, role and order onto the injection and splicing it beside main in the absolute list — so `placementFor` mirrors a depth-placed main with a depth placement. When there is **no** main section at all (disabled, empty, or filtered out by this generation's `injection_trigger`), upstream finds neither a main message nor an absolute main prompt and **loses the injection entirely**. Iris keeps it at the old ends of the system block and says so here: silently deleting a card's text is the one outcome the prompt panel cannot explain, and a preset with no main prompt is not the case this parity is about. That is the one deliberate divergence in this entry.

**What it costs — and it is a cost, measured.** This makes prompt caching *worse* for any card that injects at these two positions. The previous round measured `爱衣`'s last turn as 5 636 system tokens out of 14 693 (`CACHE-PREFIX.md` §1.2), and inferred from that composition that a `'before'` / `'after'` injection changing every turn caps the adjacent-turn prefix at **38.4%** while it sits at the end of the system block. Beside `main` — a 35-token section at the top — the same injection caps it at roughly **0.2%**. The upper bounds that round actually *measured* for `爱衣` (74.9% – 86.8% over 9 adjacent pairs, mean 82.3%) do **not** move: its probe could not see `ChatEntry.extensionPrompts` at all (a per-entry `Map` that never reaches disk, so a headless run has no card-script injections in it), and so those pairs contain no `'before'` / `'after'` injection to relocate. **The number for `爱衣` is therefore "no change measured, and none measurable by that instrument"**, and the 38.4% → ~0.2% figure is an inference from a composition, not a reading. `scripts/cache-prefix-probe.mjs` does not exist in this worktree, so nothing here was re-run.

The ruling this follows is the standing one: compatibility is the floor. A card that injects a rule "before the prompt" was having it land behind four hundred lines of preset that the rule was supposed to qualify, and reading order is behaviour.

**Two intra-group orderings found and deliberately not changed**, because they are separate from the anchor and half-fixing them would be worse than either state:

- Upstream inserts each `'before'` injection with `unshift`, so **two** of them come out in the *reverse* of the order they were processed in. Iris sorts them stably by key, so they keep key order.
- Upstream's iteration order for these two positions is `for (const key in extensionPrompts)` (`openai.js:1445`), i.e. **insertion** order — not the `Object.keys().sort()` that `getExtensionPrompt` uses for the in-chat position (`script.js:3249`). Iris sorts by key for every position. Reproducing insertion order would mean modelling which frame run registered what and in what sequence, and the sorted order is at least the same on every run.

**What would overturn it.** A preset whose `main` sits deliberately at the end (a "system prompt last" layout), where "beside main" would put a card's injection at the bottom while its author plainly meant the top. Upstream has the same problem and answers it the same way, so the fix would be upstream's too.

## 26. Two records added beside the prompt: a request fingerprint, and a zero for a slot that fired nothing

**Kind: two deliberate improvements, neither with an upstream counterpart.**

**(a) The request fingerprint.** A provider reports `cacheReadTokens` per call, and a turn that comes back with `0` has two possible causes with opposite fixes: *we* sent something different from last turn (a macro that re-rolled, an injection that moved, a world-info entry that fired), or the provider did not serve its cache. After the fact nothing could tell them apart, because the request is gone — the previous round's three 0% turns are still undecided for exactly this reason (`CACHE-PREFIX.md` §2.1). So every generation now records two hashes of the body it sent (`src/fingerprint.ts`): `promptHash` over the whole canonical body, `prefixHash` over its first 4 096 **bytes**.

- **Bytes, not tokens**, and the choice is load-bearing: this host's counter is a calibrated *estimate*, the provider's tokenizer is not available to us, and a prefix defined in estimated tokens would move whenever the estimate was recalibrated — the hash would change while the bytes did not, which is precisely the false positive the record exists to rule out. It is therefore a proxy for "did the leading text change at all", not a measurement of how much the cache could have served; the `cacheReadTokens` figure beside it is the measurement.
- **What is hashed**: provider, model, the system slot, and every message's role and text — everything a cache can match on. **Not** sampling, `maxTokens` or `stop`: a temperature that jitters between turns must not read as prompt drift.
- **Where it lands**: on the candidate-level `iris/usage` record, in the *same* file object as the cost buckets (`iris_usage[swipe]`), because they are one record about one generation and a parallel array would be a second thing for SillyTavern's swipe deletion to shift out from under. `parseUsage` ignores the two extra keys, so a file written now is read back by an older reader with its costs intact. **The protocol is unchanged**: no hash reaches `MessageView`, `ChatView` or any other wire shape.
- **Where it is read**: one `DebugReport` per generation, `kind: 'prompt'`, `grade: 'note'`, reading `prompt <promptHash> prefix <prefixHash> cache-read <n|unreported>`. Emitted in a `finally`, so an aborted or refused generation still leaves its line — those are the turns whose cache figure is missing, and a gap there falls exactly where a reader is counting turns. `unreported` and `0` are kept distinct, because only one of them is a cache miss.
- **What it costs**: 16 hex characters × 2 per swipe in every chat file, forever (a 64-hex digest would be four times that for a comparison decided in the first eight); one `sha256` over the body per generation; and one more note per generation in the report ring, which shortens the window of older reports the panel can page back through. A generation whose provider reports **no** usage stores no fingerprint — there is no record to hang it on, and half the pair persisted alone answers nothing while looking like an answer — so its line in the report is the only trace.

**(b) The zero row.** `itemize` states the rule already: "counted from the contributions rather than from the rendered request, so a part that contributed nothing still appears with a zero — a user looking for why a section is missing is better served by a zero than by an absence" (`@iris/pipeline`'s `assemble.ts`). It could not deliver it, because `resolvePreset` drops an item whose text is empty *before* a contribution exists (`chat-completion.ts:247`, `if (text.trim().length === 0) continue`). So a turn on which no world info fired showed **no** `worldInfoBefore` line at all — and the absence reads as "Iris does not implement that slot", which is the exact question the panel gets opened to answer.

`emptyMarkerRows` (`src/prompt.ts`) offers a zero-token contribution for each **marker** slot the preset ordered and this generation could not fill. Markers only: a marker is a slot the *host* fills, so its emptiness is a fact about this turn, while a preset item with blank `content` is a prompt its author left blank and a row per blank would add dozens that say nothing. The two reasons a slot can be missing that are *not* "it was empty" — a continue drops the whole post-history section, and an item's own `injection_trigger` can exclude it — are excluded, because zeroing those would claim a slot was offered when it never was.

**What it costs.** The prompt panel gets more rows. Measured on a bare chat with `DEFAULT_PRESET` and a card carrying only a description: the itemization was `main:36 | charDescription:6 | chatHistory:2` and is now that plus **six** zeroes — `worldInfoBefore`, `personaDescription`, `charPersonality`, `scenario`, `worldInfoAfter`, `dialogueExamples`. `jailbreak` gets none, and correctly: it carries empty `content` rather than being a marker, so it is an author's blank prompt and not an unfilled slot. The request itself is byte-identical — `renderSystem` drops empty text before it joins, `injectAtDepth` skips it, and `count('')` is 0, so the itemization's parts still sum exactly to its total. **The natural home for this is `resolvePreset`**, which is the function that decides to drop them; it lives in the app service because that was this round's write scope, and the visible consequence of the split is that the zero rows are appended after the preset's own contributions rather than interleaved into the order — the itemization lists contributions in array order, so they group together after the sections that produced text.

**What would overturn it.** For (a): a provider that reports which prefix it matched, which would make the proxy unnecessary. For (b): moving the zero into `resolvePreset`, which would put the rows back in preset order and let `emptyMarkerRows` be deleted.

## 27. A listing of one card's world books, with the entry text left out

**Kind: deliberate improvement — a read upstream has no member for.**

**Upstream** answers two questions about a card's world info and neither is this
one. `getCharWorldbookNames` (TavernHelper) returns **names**: the card's
`extensions.world` and the stored extras, and the caller fetches contents itself.
`getWorldbook(name)` / `SillyTavern.loadWorldInfo(name)` return **one whole
book**, every entry with its `content`. There is no "tell me what this card's
world info consists of" — because upstream never needs one: the world info editor
is opened on the character that is playing, and it is an editor, so it wants the
text.

**Iris adds `worldbook.charDigest`** (`characterId` → `{books}`), which is the
listing shape: for each book the card involves, every entry's `uid`, `name` (the
file's `comment`), `enabled`, `constant`, primary keys, secondary keys when it
has any, position, and `depth` where the position uses one. **No `content`.**
`cardWorldbookDigest` in `worldbooks.ts` builds it; the entry mapping is
`toEntryDigest` and it lives in `@iris/protocol` because the fake client
produces the same shape and two copies of an inverting mapping (`disable` →
`enabled`) drift silently.

**It is a second reading of an existing decision, not a second decision.** Which
book is the card's own comes from `cardWorldbookView` and from nothing here, so
the character page and the world book panel cannot name different books for one
card. The extras come from `settings.charBooks`, the same reader
`worldbook.charNames` uses. `globalSelect` is deliberately **not** read: a
globally selected book applies to every character, and listing it under one card
would report an installation-wide setting as a property of that card.

**Three book states, all listed.** A file; the card's embedded `character_book`,
which is where a card nobody has opened on this host still sits (converted the
way `materialise.ts` converts it — `fromCharacterBook` then `toWorldbookEntry`,
because a card book is the V2 spec's shape and reading it as a book file's gives
every entry a default position and no keys); and a **bound name with nothing
behind it**, reported as `source: 'missing'` rather than dropped. That last one
is 2 of the corpus's 18 bindings, and it is the case a listing has to keep: a
binding that activates nothing is otherwise indistinguishable from a book with
no entries, and only one of those is a broken card.

**What it costs, measured against the operator's own profile** (13 cards, 11
carrying a book, 841 entries between them):

| card | entries | `charDigest` | the same book through `worldbook.get` |
| --- | --- | --- | --- |
| `Sgw又看一集` | 140 | 23 489 B | 349 188 B |
| `魔法少女的扣扣审判1` | 153 | 20 526 B | 1 161 905 B |
| `银麒赎世` | 129 | 20 393 B | 839 338 B |
| `爱衣` | 12 | 1 483 B | 51 732 B |

15× to 57× smaller, and the difference is entirely `content`. The read itself
costs what `worldbook.charNames` with `withCard` already costs — one card
decode, one binding-table read, one book file per book — plus the per-entry
mapping; there is no new file access pattern and no cache.

**Refused, never answered empty, on a host with no book store.** `{books: []}`
is already the answer for a card that carries no world info, and a store-less
host giving it would be reporting a fact about a card it never looked at. Same
line every read in this family draws.

**What would overturn it.** A book large enough that ~23 KB stops being the
ceiling — the shape would grow a `limit`/`cursor`, not a per-book call. Or
upstream growing a listing member of its own, at which point this should be
renamed to match it.

## 28. A usage record now says which model spent it and when, and one RPC adds them up across the profile

**Kind: deliberate improvement, with a named reconstruction for everything
already stored.** §22 recorded what the provider charged, per generation, where
upstream records only its own estimate of the reply. This is the half that makes
those numbers *answerable*: a cost that names neither a model nor a moment can
be added up and nothing more.

**Measured first.** Over the 16 real conversations on this machine
(`apps/iris/data/default-user/chats`, 2026-09-08, 566,905 bytes, 64 lines):
**12 usage records, none of which carries a model, a provider or a timestamp** —
seven hold the five token buckets alone, five hold a `promptHash`/`prefixHash`
pair as well. Nor is there any per-message date to fall back on: Iris's export
writes no `send_date`, so an assistant line's keys are
`iris_usage, is_user, mes, name, swipe_id, swipes` and nothing else. "Which
model is costing me this" was not a question the corpus could answer.

**(a) Three fields on the record, in the object the buckets already ride in.**

`TurnUsage` gains optional `model`, `provider` and `at`. They are on that type
and merged onto that object rather than parked in a sibling array for the reason
`USAGE_FIELD` gives at length: SillyTavern's swipe machinery swaps `extra`
wholesale and its swipe *deletion* splices `swipes` and `swipe_info` while
knowing nothing about parallel arrays. One object per swipe is the shape that
survives, and it is the shape `PromptFingerprint`'s hashes already ride in. It
also means the fields reach `MessageView.usage` for free and survive the log
rebuild without a line of new code, because the rebuild carries the usage object
across by position.

- Stamped **once**, at the site that already computes the request fingerprint
  (`service.ts`, beside `notePromptFingerprint`) — the one place the composed
  request is in hand, so the model, the provider and the moment are one reading
  of one request rather than three guesses taken at three times. Parked on
  `pending.route` under the same guard as `usage` and `fingerprint`, because the
  candidate does not exist until the turn settles.
- `at` is when the **request** went out, not when the reply settled. One site
  rather than two, and for a figure bucketed by hour or day the difference is not
  observable — while a second `Date.now()` at settle time would let a turn that
  streamed across midnight land in a different bucket from the fingerprint
  recorded beside it.
- A **blank** model is dropped rather than stored. A host started with nothing
  configured composes `model: ''`, and a blank string would draw a chart series
  with no label: the unknown case wearing a known case's clothes. Dropped, it
  reads as unknown, which it is.
- `sumUsage` is unchanged and **does not carry them**: it builds its total from a
  fresh object over the four optional buckets, so every aggregate has all three
  absent. That is the honest reading for a conversation that ran on several
  models across several days, and it is stated on the type — a consumer that
  finds `model` on an aggregate has found a bug, not a route.

**(b) `usage.summary`: one scan, rows only.**

`ChatStore.usageSummary` (`src/usage-summary.ts` for the reading and the
arithmetic, both pure) answers with `(bucket, model)` cells, per-conversation
subtotals, the range totals, and the model names — never a floor.

The shape a browser reaches for is `chat.list` and then a `chat.open` per
conversation, and that is wrong twice over: it ships every floor of every
conversation across the wire to compute a dozen sums, and **`chat.open` is a
stateful call on this host** — it loads the entry, composes the card's scripts
and can raise the legacy-cleanup offer. Reading a statistic must not have side
effects. So this is `ChatStore.search`'s scan with `ChatStore.search`'s
reasoning: the files are the truth because every write goes through `save`, one
substring check per line, and `JSON.parse` only on the lines that carry
`iris_usage`.

| what | where |
| --- | --- |
| Wire method and its refusals | `packages/iris-protocol/src/rpc.ts`, `'usage.summary'` |
| Row shapes and every rule they carry | `packages/iris-protocol/src/views.ts`, `UsageTotals` / `UsageBucket` / `UsageChat` / `UsageSummary` |
| The scan | `src/chats.ts`, `ChatStore.usageSummary` |
| The reading and the fold, pure | `src/usage-summary.ts` |

Three rulings inside the row shape, each of which a plainer design gets wrong
silently:

- **No `input` and no `total` field.** Billed prompt is `cacheMiss + cacheRead +
  cacheWrite` and the total is that plus `output`. Both are one addition a
  reader can defend; a stored field duplicating a stored field is a number that
  can disagree with itself. (`cacheMiss` is `inputTokens` summed, and on a
  DeepSeek route it *is* `prompt_cache_miss_tokens` — the adapter derives it as
  `prompt_tokens - cached_tokens` and DeepSeek documents `prompt_tokens =
  prompt_cache_hit_tokens + prompt_cache_miss_tokens`.)
- **`cacheTurns` and `cachePrompt` carry the hit rate's population.** The share
  is `cacheRead / cachePrompt`, both restricted to the generations that reported
  a cache bucket, so a route that says nothing about caching cannot dilute one
  that does. Dividing by every prompt token in range is the nearest wrong
  implementation and it produces a plausible smaller percentage: on a
  two-generation fixture, 19% where the fact is 75%.
- **`undatedTurns` is a count, not a flag.** Counts compose under aggregation
  and flags do not, and this is the one number that says how much of a
  time-sliced reading is a reconstruction.

The scan differs from `list` and `search` in exactly one way: **an unreadable
file is counted, not swallowed.** Skipping silently is right for those — one
corrupt chat must not make every other conversation unreachable — but a summary
is a claim about a total, and a total over an unknown fraction of the corpus is
not one. `scannedChats` and `skippedChats` ride in the reply.

**What it costs.** The undated fallback, and it is a reconstruction rather than a
reading: a record with no `at` is placed at its conversation's `updatedAt` (or
its `create_date` where the header carries no Iris block, or the epoch where
neither is readable), so **every undated record in a chat lands in one bucket**.
An old conversation therefore reads as a single spike at its last activity. That
is reported as `undatedTurns` rather than smoothed, because smoothing would
invent a distribution the files do not contain — currently 12 of 12 on the real
corpus.

And the scan is linear in the profile's bytes, once per request, with no index
and no cap. Measured through this reader against a read-only copy of the profile,
2026-09-08: the reply is **1,300 bytes** at day granularity and **1,446** at
hour, over 16 conversations and 566,905 bytes of files; 爱衣 alone is **629
bytes** for 9 records. The reply's size is set by (buckets × models) and by the
number of conversations, never by their length.

**Found and not changed, because it is another feature's decision.**
`chats.ts`'s `parseCreateDate` cannot read the headers this host writes. Its
regex requires a trailing `ms` (`(\d{3})?ms`) while `formatCreateDate` in the
same file ends at the seconds — `2026-08-31 @21h04m17s`, that function's own
documented example. So it answers `undefined` for **16 of 16** real headers here,
and its test (`chat-transfer.test.ts`) only ever tried the SillyTavern spelling
`…21s771ms`, which is why nothing said so. Its one caller is the import path,
where an unparseable date falls back to the arrival time, so fixing it moves how
imported conversations sort. `usage-summary.ts`'s own reader therefore accepts
both spellings and says why, and the divergence is recorded here rather than left
to be found as "two readers of one field disagree".

**What would overturn it.** Recording a per-message timestamp in the chat file
would retire the undated fallback and its count. A profile large enough for the
scan to be felt would make the uncapped reply the wrong shape — and the answer
then is a host-side index invalidated on write, not a cap. A provider reporting
a route per *block* rather than per request would make one `model` per record
the wrong unit, the way the harness's `routes` array already anticipates.

## 29. Older history is replaced by a summary **at assembly**, not deleted; upstream's Summarize injects a summary and sends the history anyway

**Kind: deliberate improvement** (ROADMAP's second ledger), so this entry owes
three things — what is better, what it costs, and why upstream does not do it.

**Upstream, read rather than assumed.** SillyTavern ships a Summarize extension
(`1_memory`) and it is a *near miss* for this: it produces the same artefact and
puts it in the prompt, and then leaves the history it summarised in the request.

| what | where |
| --- | --- |
| the summary is generated | `[ST 1.18.0] public/scripts/extensions/memory/index.js:681` — `summarizeChatMain`, through `generateQuietPrompt` |
| its default prompt | `:105` — *"Summarize the most important facts and events in the story so far… Limit the summary to {{words}} words"*, `promptWords: 200` (`:118`) |
| how it reaches the prompt | `:964-965` — `setMemoryContext` → `setExtensionPrompt(MODULE_NAME, formatMemoryValue(value), position, depth, scan, role)` |
| where it lands | `:114-117` — `position: IN_PROMPT`, `role: SYSTEM`, `depth: 2`; template `[Summary: {{summary}}]` (`:106`) |
| where it is stored | `:978-983` — `mes.extra.memory = value` on the pre-last message, then `saveChatDebounced()` |
| how the newest one is found | `:365`, `:386` — walk the reversed chat (minus the last row) for the first `mes.extra.memory` |
| **what it does to the history** | **nothing.** No path in the file touches `context.chat`; `getContext().chat` is read (`:597`) and never spliced |

So on upstream a long conversation that has been summarised sends *both* — the
summary at depth 2 **and** every floor it summarises — and the only thing that
removes a floor from the request is the token budget silently dropping it off
the front. The extension is off by default and asks for a summary every ten
messages (`promptInterval: 10`, `:123`).

**Iris.** The summary replaces the span it stands for, in the one place the
conversation is projected for a request. `#history` is
`applyCompaction(#rawHistory(…), readCompaction(entry.header))`, and every
consumer goes through it — the real turn, the world-info scan, the itemization
record, the preview, and `TavernHelper.generate`. The replacement is one
`HistoryEntry` at the head of the conversation, `role: 'system'`,
`pinned: true`, carrying the framed checkpoint. `src/compaction.ts`,
`src/compaction-prompt.ts`, `tests/compaction.test.ts`.

**No message is deleted, and that is the compatibility floor.** The chat file
keeps every floor; `ChatView.messages` keeps every floor; a compacted chat
opened in SillyTavern is a complete chat with one unknown header key. What
changed is only what the model is sent — which is exactly the relationship
upstream's own extension has to a chat, one step further.

**Two triggers, both the harness's.** Automatic at 80% of the available budget
(`agent/pre-step` in `dsh-compaction-basic`; here the top of `#start`, before
`entry.begin`), retaining a 16% verbatim tail. Manual `chat.compact` with
retention zero — everything but the newest floor. The pressure reading is the
itemization this host already records for every real turn
(`entry.itemizations`), so the trigger costs no second assembly; like the
harness's, it describes the **previous** request, and the 80% threshold is what
makes that lag affordable.

**Where the record lives, and why not the three obvious places.** A top-level
`iris_compaction` key on the chat **header**, beside `iris` and
`chat_metadata`. All three alternatives lose it silently, which is this
feature's worst outcome — a lost record means the next request quietly
re-includes the whole span, the conversation gets more expensive, and nothing
says why.

- **Not a message's `extra`**, which is where upstream puts its own summary.
  SillyTavern treats `extra` as per-swipe state it swaps **wholesale**:
  `targetMessage.extra = structuredClone(targetSwipeInfo?.extra) ?? {}`
  (`public/script.js:6956`). One swipe of that floor there and the record is
  gone. `src/usage.ts` measured this first and `iris_usage` sits at the top
  level for the same reason; this key follows its naming. *(It is also a live
  hazard for upstream's own extension: a swipe on the floor carrying
  `extra.memory` discards the summary, and the walk at `:365` then finds an
  older one or none.)*
- **Not `chat_metadata`**, even though that is upstream's home for chat-scoped
  state and `timedWorldInfo` and `variables` already live there.
  `commitChatMetadata` (`src/context.ts`) **replaces the block wholesale**
  ("because that is what upstream's object semantics give a card") and is
  reachable from the browser as `script.saveMetadata`. Any card that reads the
  metadata, sets one key and saves would delete the record. The two existing
  residents live under that hazard because upstream put them there and
  compatibility is the floor; nothing forces a third.
- **Not `header.iris`**, which survives save and open but not a round trip:
  `ChatStore.importFile` re-mints that block wholesale.

An unknown top-level header key survives all of it: `formatChatFile` writes the
header verbatim, `parseChatFile` reads it verbatim, `importFile` does not touch
unknown header keys, and SillyTavern ignores header keys it does not know —
which is why `iris` is allowed to live there at all.

**The unit is a count of leading floors, not a message id.** That is the unit
the substitution is written in: the assembler is handed a list of history
entries and the summary replaces its first `count`. An id would be converted at
every read, and the conversion is where an off-by-one hides.

**What it costs.**

- **One extra model call per compaction, and the user pays for it.** The call
  is shaped to be as cheap as it can be — the conversation's own system prompt,
  the span replayed in order, then the instruction as the final user message —
  so it is a genuine prefix of the request the conversation was already sending
  and the provider's KV cache is reused. A separate summarizer system prompt
  would have invalidated the prefix and billed the span again uncached.
- **The prompt-cache prefix is invalidated once, on purpose.** The next request
  after a compaction has a different message prefix, so
  `fingerprintRequest`'s hash moves and that turn reads no cache. That is the
  signal the fingerprint exists to give, and it is the price of the reduction
  the compaction just bought.
- **The summarization sends the preset's system prompt**, jailbreak included,
  which is what buys the cache alignment and is also what upstream does
  (`generateQuietPrompt` runs a full assembly). The risk it carries is a model
  that stays in character and continues the story instead of summarising;
  `compaction-prompt.ts` answers it with explicit rules ("do NOT continue the
  story, do NOT write in character") rather than by stripping the system
  prompt. **Not measured against a real provider** — the tests use a fake — so
  this is the line most likely to need revisiting.
- **A summary that is not smaller is refused**, with `unsupported`. It would
  lower nothing and the next turn would ask again. The reader gets an error and
  an unchanged conversation, which is the harness's behaviour too.
- **The summary's cost is inside the `chatHistory` itemization row**, not a row
  of its own, because it rides as a history entry. That is the right place —
  the point of the feature is that the history row *shrinks* — but it means the
  prompt panel cannot show "the summary costs N" separately. Making it visible
  means either a fourth `kind` on `PromptItemEntry` or a `Contribution` with a
  placement, and neither is worth a row.
- **A stale count is clamped rather than trusted.** A reader who deletes a
  covered floor leaves the count one too large; the clamp keeps at least one
  verbatim floor, so the cost is one over-compacted turn instead of a
  conversation with no present in it.
- **`{{firstIncludedMessageId}}` had to learn about it.** The macro is
  upstream's `chat_metadata.lastInContextMessageId`, set from
  `droppedHistory` — which counts drops from the conversation the assembler was
  *handed*, and after a compaction that starts with a summary. It is now
  offset by the record's count. Removing the offset left the whole suite green
  until a test was written for it.
- **The automatic trigger never fires on a chat this process has not generated
  in**, because the reading is the previous request's itemization and
  `entry.itemizations` is in memory only. Refused rather than substituted with
  the provider's reported prompt size: that is a different measurement of a
  different assembly, and choosing between them per call would make the trigger
  fire at two different fullnesses depending on history nobody can see.
- **An automatic failure is reported and the turn continues.** The harness logs
  and continues; copying that is behaviour parity, but silence would be
  indistinguishable from a threshold that is never reached, so a failed attempt
  lands as a `prompt`-kind fault beside the success's note.

**What would overturn it.** A measurement showing the summarization call
routinely produces in-character prose rather than a checkpoint, which would
move the system prompt out of the call and cost the cache alignment. Or a
ruling that Iris should reproduce upstream's extension *as well* — a summary at
depth 2 over an intact history — which is a different entry: it is a different
artefact (periodic, 200 words, injected near the end) doing a different job,
and the two would need different words in the interface.

## 30. A card's own regex tier runs until the user refuses it; upstream refuses it until asked

**Kind: deliberate divergence in the *default*, with the switch itself a
compatibility fix.**

**Upstream** gates the scoped tier behind `extension_settings.character_allowed_regex`,
a flat list of avatar filenames. `getRegexScripts()` defaults to
`{ allowedOnly: false }`, and the **one** caller that passes `true` is
`getRegexedString` — the engine (`extensions/regex/engine.js:35`, `:98-100`,
`:346`, gate at `:115`). So the panel, the debugger and `/regex` all *see* a
card's rules while the conversation does not *run* them. Membership starts
empty, and the extension asks once per avatar on `CHAT_CHANGED`
(`checkCharEmbeddedRegexScripts`, `index.js:1606-1633`) with a one-shot
`AlertRegex_<avatar>` key; accepting calls `allowScopedScripts` and reloads the
chat, declining leaves the key set so the question never returns.

**Iris before this round had no gate at all.** `scriptsOf` pushed
`card.data.extensions.regex_scripts` into the composed list unconditionally, so
a user could neither refuse a card's rules nor switch one of them off short of
editing the card. **That is the compatibility gap, and it is now closed**:
`regex.setScopedAllowed` is upstream's membership, per character, and
`regex.setScopedEnabled` is the per-rule switch.

**The default diverges, deliberately.** `ScriptPolicyStore.regexAllowed` absent
means **allowed** (`!== false`), where upstream's absent means refused. Three
reasons, in the order they carried weight:

1. **A regex rule rewrites text; it cannot execute.** The consent question this
   host already asks — 「这张卡的脚本要不要跑」, three-state, stored — is about
   arbitrary JavaScript in the page. Putting a second modal in front of a
   text substitution would spend the user's attention on the cheaper risk and
   teach them to click through both.
2. **Refusing by default visibly corrupts the reading.** Measured over the 19
   local cards: **15 carry this tier, 173 rules in total**, and every one of
   those 173 carries all 13 fields. **Eleven of the fifteen** use that tier to
   strip the card's own `<UpdateVariable>` blocks out of the transcript and out
   of the next request, and **all fifteen** carry at least one live
   display-only rule — so refusing the tier by default changes what the reader
   sees on every one of them. A "safe" default that prints command blocks into
   eleven of nineteen conversations until the user finds a switch is not the
   safe one — and the same install's `character_allowed_regex` already held
   **15 entries**, i.e. the operator had said yes to every one of them.
3. **It is the behaviour this host already had.** The divergence is the *lock on
   a door that had none*, not a new opening.

**Absent and "allowed" are genuinely one state here, because nothing asks.**
`true` deletes the key and `false` is written — the opposite of `scriptsAllowed`
in the same record, where absent and `false` must stay distinguishable because
the difference *is* the feature. **A later round that adds the question has to
add the third state first**, and both the field and the RPC say so.

**What would overturn it.** A card observed using its own regex tier to hide
something from the reader rather than from the model — an instruction rewritten
on the way to the page, say. That is an argument for asking, and the change
would be the third state plus a one-shot question keyed on the character, which
is exactly upstream's shape.

## 31. The user's switches over a card's regex rules are stored beside the card, not written into it

**Kind: deliberate improvement, and the same ruling `script-variables.ts` and
`script-buttons.ts` already made.**

**Upstream** writes a scoped rule's `disabled` back into the character with
`writeExtensionField(this_chid, 'regex_scripts', scripts)`
(`engine.js:148`, called from the row's disable checkbox at
`index.js:653-657`), which mutates `data.extensions.regex_scripts` on the live
object *and* patches `character.json_data`
(`public/scripts/extensions.js:2061-2091`).

**Iris keeps them in `script-policy.json`**, as `regexEnabled: Record<ruleId, boolean>`
per character, and hands the composed rule to the engine with `disabled`
folded in (`regex.ts`'s `withUserSwitch`).

**Why.** A card is a document people share. The card's own `disabled` is a fact
about the card and travels with it through export and re-import; the user's
switch is a decision about this installation, and fusing them lets a re-import
quietly revive a rule the user had turned off — the argument
`ScriptPolicyStore`'s own docblock makes about card scripts, applied to the
tier beside them. It also means this host never rewrites a card file to record
a preference, which is the property that makes a card's bytes stable enough to
fingerprint.

**The cost, stated.** A rule switched off here and then exported carries the
*card's* `disabled`, not the user's. That is correct — the export is the card
author's rule, and the file is meant to be one an install accepts — but it means
"what I see in the panel" and "what my export says" can differ on that one
field, and nothing reports it.

**An unnamed rule keeps the card's word.** A switch is addressed by the rule's
`id`, so a rule carrying none cannot be overridden; the panel renders the row
without a control and says why. Upstream assigns ids lazily (on render, on
save, on migration), so this is reachable in principle — though all 173 rules
in the local corpus carry one.

**What would overturn it.** A decision that Iris should write cards back at all,
at which point this becomes one field of a larger question rather than its own.

## 32. The user's own scripts live in a file of their own; upstream's per-character repository lives in the card

**Kind: deliberate improvement — the third instance of one ruling.**

**Upstream** (酒馆助手 4.9.1, read from
`data/default-user/extensions/JS-Slash-Runner/src/`) keeps three script
repositories:

| repository | where the scripts live | where "this repository may run" lives |
| --- | --- | --- |
| global | `extension_settings.tavern_helper.script.scripts` (`store/settings/global.ts:22,43`) | `…script.enabled.global`, a boolean |
| preset | `preset.extensions.tavern_helper.scripts` (`store/settings/preset.ts:9,33`) | `…script.enabled.presets`, preset **names** |
| character | `character.data.extensions.tavern_helper.scripts` (`store/settings/character.ts:34,47`, via `writeExtensionField`) | `…script.enabled.characters`, character **names** |

and merges them global → preset → character at run time
(`store/iframe_runtimes/script.ts:26-32`).

**Iris keeps two of them, in `script-library.json`**: `{ global, characters }`.
The preset repository is absent for the reason the preset *regex* tier is
absent — this host's preset library is read-only, and a repository the user
could see but not write would be a promise of edits that do nothing.

**The character repository is not in the card, and that is the load-bearing
difference.** Upstream's is: sharing a card ships the sharer's own scripts inside
it, and — because upstream's script-variable table is the `data` field of the
script object, persisted by a deep watcher (`store/settings/character.ts:152-160`)
— ships whatever those scripts have accumulated as well. This is the same
argument `script-variables.ts` and `script-buttons.ts` already made for their own
fields, and it is stronger here because the payload is arbitrary code rather
than a few kilobytes of state.

**Kept apart from `script-policy.json` too.** That file is the user's
*decisions* about someone else's code; this one is the code. A settings reset
must not be able to delete the user's work, and a library restore must not be
able to hand a card a document grant.

**Dropped when the character is deleted** (`ScriptLibraryStore.forget`, called
from `character.delete`). Ids are minted from a card's name against the cards
**present**, so deleting "Aria" frees the id and the next card imported under
that name takes it. A repository left behind would not be orphaned — it would be
**inherited**, and what it holds would then start running in a stranger's
conversations. This is the strongest case in that handler's list.

**What would overturn it.** A user asking to share a card *with* their scripts,
which would be an export decision (a card export that folds the repository in on
request) rather than a change of where it lives.

## 33. A library script's variable table is stored and round-tripped, but is not the live `script` scope

**Kind: known gap, recorded rather than closed.**

**Upstream's script variables *are* the script object's `data` field**:
`getVariables({ type: 'script', script_id })` reads
`useScriptIframeRuntimesStore().get(script_id)?.data` and a write assigns
`script.data = variables` (`function/variables.ts:88`, `:178-182`), which the
deep watcher then persists into whichever file the repository lives in.

**This host keeps the `script` scope in `script-variables.json`**, partitioned
`Record<characterId, Record<scriptId, Variables>>`, seeded from a card's
`scripts[].data` on first open (`script-variables.ts`). A library script's
`data` is **stored and round-tripped** by `ScriptLibraryStore` — an import
carries it in and an export carries it out — but nothing seeds the variable
store from it, and nothing writes it back.

**So there are two consequences, and both are real:**

1. A script imported *with* a populated table starts with an empty `script`
   scope. Its first read sees nothing and it re-initialises, which is a state
   every such script already handles on a fresh install.
2. A **global** library script's `script` scope is per character here, because
   the partition is keyed by character; upstream's is one table shared across
   every conversation. A global script that counts something would count
   separately per card.

The second is the one that could surprise someone. It is not fixed in this
round because the fix is a decision about `ScriptVariableStore`'s partition key
rather than about the library — a `.global` section beside the character ones,
with the same leading-dot reservation `ExtensionSettingsStore` uses — and that
touches the scope every card script already reads.

**What would overturn it.** A global library script observed to need one table:
the change is a reserved partition in `script-variables.json` plus a
`scriptIdOf` selector that routes to it by source.

## 34. A script created or imported here arrives switched off — which is upstream's default, and not this host's for card scripts

**Kind: compatibility, and worth writing down because the *neighbouring*
default is the other way.**

**Upstream**: `Script.enabled` is `z.boolean().default(false)`
(`type/scripts.ts:20`), `ScriptFolder.enabled` likewise (`:38`), and the
importer forces `script_tree.enabled = false` again after parsing
(`panel/script/Toolbar.vue:94`). A newly created or imported script does not
run.

**This host's card-script extractor defaults the same field the other way**:
`@iris/script`'s `extract.ts:104` reads an absent `enabled` as `true`, "because
the field was added to the format after cards existed". That is right for a
legacy card — a card whose scripts all read as off would appear broken — and
wrong for a library the user writes into, where the author's silence is not a
historical accident.

**One field, two justified defaults, and the discriminator is who wrote the
script.** `ScriptLibraryStore.save` uses `input.enabled ?? previous?.enabled ?? false`,
so a create arrives off, and an **edit** keeps whatever the user last chose —
otherwise fixing a typo in a running script would switch it off.

## 35. Correction: the regex tier run order was read off the constants' values instead of upstream's iteration order

**Kind: compatibility fix. Nothing in this host could observe it.**

Upstream declares `SCRIPT_TYPES = { GLOBAL: 0, PRESET: 2, SCOPED: 1 }` and
iterates it with `Object.values(SCRIPT_TYPES)` — **key insertion order** —
so the run order is global, then the preset's, then the character's own
(`extensions/regex/engine.js:11-16`, consumed at `:99`; the source's own comment
there is "ORDER MATTERS: defines the regex script priority"). The numeric values
deliberately do not match that order.

`@iris/regex`'s `orderScripts` sorted by `type`, which gives global, character,
preset — the last two swapped — and its docblock and its test both stated that
order as if it were upstream's. **The bug was unobservable**: this host has no
preset tier to pass in, so every input that exists produces the same list under
either rule, and the test agreed with the implementation. It would have shipped
with the preset tier, green.

The fix is `TIER_ORDER`, a rank kept separate from `SCRIPT_TYPE` precisely
because the two disagree, and the test now asserts that they still disagree —
so a future renumbering cannot silently make the case stop discriminating.

## 36. Every real request's body is kept on disk, so a cache miss can be attributed

**Kind: an Iris diagnostic improvement.** Upstream has nothing like it and does
not need one — SillyTavern does not report a provider's cache figures at all.

### The gap this closes

`CACHE-PREFIX.md` (2026-09-07) measured the user's own corpus and ended with an
item it could not act on (§5.3): *真实请求不留任何可回查的痕迹*. Two turns of
`爱衣` reported `cacheReadTokens: 0` and there was no way to tell "we sent
something different" from "the provider did not serve its cache" — opposite
faults with opposite fixes. `fingerprint.ts` (§17) answers the first half: two
hashes per generation settle *whether* the prompt changed. It cannot answer
*where*, or *whose text that was*, because a hash is not a diff.

### What is written

Each real generation writes `<profile>/cache-trace/<chatId>/<seq>.json`:

| field | what |
| --- | --- |
| `body` | the canonical body, verbatim — the bytes a prefix cache is decided over |
| `spans` | one `{ id, kind, role, start, end }` per assembly part: **byte offsets into `body`** |
| `promptHash` / `prefixHash` | the same two hashes the chat file already stores |
| `provider` / `model` / `at` / `kind` / `turn` | the route, the moment, and what kind of generation it was |
| `inputTokens` / `cacheReadTokens` | what the provider said, once it said it |
| `attributed` / `attributionNote` | false when a byte could not be assigned to a part with certainty |

The byte offsets are the new thing. `prompt.ts` and `@iris/pipeline` already
itemized a request by *token count*; nothing recorded **position**, and position
is the whole question — a section that is byte-identical every turn is still
re-billed in full if it sits after the divergence point. So `renderSystem` now
also returns its seams (`systemSegments`), `injectAtDepth` stamps each message
with the contribution or floor that produced it, `historyFromSession` gives each
floor a stable `history.<n>`, and `TurnDriver` records the map **after** its
squash, postfix and tail — the three things that stand between what `assemble`
returned and what the provider is sent.

**Provenance is not content.** The map rides on `GenerateOptions.layout`, a field
both serialisers cannot emit because both name their fields as literals; every
path to a provider reads `role` and `text` and nothing else.

**It describes the reordered request, not the one §38 would have sent without
the reorder.** `systemSegments` takes the same `cacheFriendly` the assembly took,
so a deferred section is absent from the seams exactly as it is absent from the
system string; a deferred or promoted contribution becomes its own message and
carries its own `id` there, which is the only place its provenance can ride once
it has left the system string. Getting this wrong is not a cosmetic error — a
segment list naming a section the string no longer holds hands the trace offsets
past the end of the slot, and offsets that are confidently wrong are the one
output this instrument must not produce. The squash the map is taken after joins
a run with **one newline** (§41), not with the blank line `renderSystem` uses;
the two separators are written out in both places rather than shared, so a
change to either has to be made in the other and the parts stop reconstructing
their slot — visibly, as an unattributed trace — if it is not.

### Size, and how to turn it off

Bounded per conversation: only the newest `cacheTraceKeep` files survive, default
**8**. Measured on a seeded probe of a `爱衣`-shaped conversation a body is 5–6 KB;
on the user's real `爱衣`, whose newest turn was billed 26 300 tokens, a body is
roughly 90 KB — so one conversation holds **about 700 KB** at the default, and
the profile's 16 conversations a few megabytes at worst.

- `IRIS_CACHE_TRACE=0` — off entirely. Nothing is written, nothing is read, the
  directory is not even created, and `prompt.divergence` answers with no
  comparison (the same answer a first turn gets).
- `IRIS_CACHE_TRACE_KEEP=N` — the retention.

**On by default**, which is a deliberate default for a store holding the user's
prompts. Three reasons: the question it answers is one the user has already asked
and nothing else can answer; the data never leaves the machine — it is the user's
own text in the user's own profile directory, bounded and deletable; and a
diagnostic that is off by default is never on when the thing it explains happens.
It is a count rather than a boolean beside a count, so one knob cannot disagree
with itself about whether the record exists.

Written atomically (`<seq>.json.<pid>.tmp` then `rename`, the pattern
`worldbooks.ts` uses), only inside its own subtree (every path through `fileFor`,
so a chat id off the wire cannot name a file elsewhere), and rotation deletes only
names it can parse as its own. **A failed write never fails a generation**:
`CacheTraceStore.write` catches, reports and returns.

### Correction: the route was inside the hashed bytes

The canonical body used to open `{"provider":…,"model":…`, and `prefixHash` is the
first 4 096 bytes **of that string** — so **switching model changed the prefix
hash while the prompt was untouched**. The composer switches model per
conversation, so this is a shape the user produces.

It also makes the lead this round started from unsafe. The two swipes of `爱衣`
message 25 have different `prefixHash` and were read as "the head 4 KB changed",
but the second reports 7 424 cached tokens — a shared wire prefix of roughly
20 KB, which a request whose first 4 KB really differed could not have had. The
two readings are arithmetically incompatible; a route change accounts for both.

So the hashes now cover the **prompt only**: the system slot and every message's
role and text. The route is recorded as its own fields, where a change reads as a
route change — `PromptDivergence` carries `model`/`previousModel` and
`provider`/`previousProvider`, and a switch is reported as one of the three
reasons a miss needs no further explanation.

**The cost, stated because it is otherwise silent**: hashes stored before this
change were taken over a different string and cannot be compared with ones taken
after it. One boundary turn per conversation will read as "the prompt changed"
when it may not have. Nothing repairs that — the old bodies are gone.

### The three reasons a miss is nobody's defect

DeepSeek's documented behaviour, and each on its own explains a miss on a
byte-identical prompt. `providerExcuse` lives in `@iris/protocol`, so the
interface and the offline report draw the same line, and it is checked before any
shortfall is reported:

- **cold start** — a prefix is stored only after being seen twice, so the first
  two requests of a conversation cannot hit. `爱衣`'s first recorded turn
  reporting `0` is fully explained by this and nothing else.
- **stale** — entries live "hours to days"; the 30-minute threshold is named as a
  reporting choice rather than as a measurement.
- **route** — a cache belongs to one model.

Without this, the report would open with three false alarms per conversation.

### The four terms add up

`CACHE-PREFIX.md` §1.2 split each pair's unservable bytes two ways ("新文本 +
前缀后逐字重复") and the two terms do not sum to the total: row 3 reads
`10 508 = 4 688 + 5 393`, which is 10 081. The residue is JSON framing and the
blank lines between system sections, and it was never named. `PromptDivergence`
splits four ways — `addedBytes`, `changedBytes`, `repeatedBytes`,
`structureBytes` — and the fourth is the remainder **by construction**, so the
terms sum exactly and a test asserts it. A reader who adds them up gets the
total; there is no rounding to assume.

Separators between system sections belong to no part, and that is a decision: the
blank line `renderSystem` puts between two sections is the cost of there being
two sections, not text either one wrote. Those four bytes per seam land in
`structureBytes`. Attributing them to the following section would make a
section's reported size disagree with its own text.

### Two things found and not changed

1. **A card's own generations are billed and appear on no usage page.**
   `#sideGenerate` and `#generateRaw` — the `script.generate` and
   `script.generateRaw` arms — call `#stream` with **no `entry`**, and
   `noteUsage` / `notePromptFingerprint` / `noteRoute` are all guarded on
   `entry?.pending?.turn`. So a card that fires one of these every turn (MVU
   does) spends the user's tokens invisibly. The **trace** now covers them,
   labelled `kind: 'side'` with the RPC method in `caller`, so they are at least
   countable and no longer appear as an unexplained gap in the sequence numbers.
   The usage *page* is not fixed here: doing so means a new `source` field on the
   stored `TurnUsage`, which is the chat-file format, plus `usage-summary` and the
   usage panel — three surfaces this round does not own.

   The script's **name** is also not recorded, because it is not available:
   `script.generate`'s wire schema is `chatId` / `userInput` / `systemPrompt` /
   `maxHistory` and carries no script id. `caller` names the method, and is named
   as the method so nobody reads it as an attribution it is not.

2. **A new swipe is `chat.regenerate`, not `chat.swipe`.** `chat.swipe` only
   selects an existing candidate. So traces are labelled `regenerate` and there is
   no `swipe` kind to look for. Worth writing down because the corpus's sharpest
   unexplained growth is across swipes: `爱衣` message 25's four requests were
   billed 12 343 → 12 343 → 15 594 → 20 935 tokens, and the last two are the ones
   a `swipe` label would have been looked for under.

## 38. The request's parts are sorted by whether they change between turns, so a prefix cache can serve the part that does not

**Kind: deliberate divergence, on by default, with an off switch and a
measurement. The model reads the moved instructions somewhere other than where
their author placed them; that is the cost, and it is real.**

**Upstream.** SillyTavern assembles in one order and has no notion of a request
prefix. `ChatCompletion` places every prompt by its `order` / `injection_depth`
and sends it (`openai.js`); a world-info entry at `position: 1` lands in the
system block wherever its `insertion_order` puts it, whether its text is a
constant or a fresh `{{roll::1d20}}`. There is no setting to change that,
because upstream has nothing that would read one.

**Iris.** `ChatSettings.cacheFriendly` (**absent means on** — the only field in
that type that defaults to on) sorts the request's parts by whether they change
between turns, in **both** directions:

- a part classified **volatile** leaves the request's leading bytes for a
  segment placed after the whole conversation, immediately before the depth-0
  injections;
- a depth-anchored part **observed unchanged** goes the other way, into a
  segment between the system prompt and the first floor.

Order inside each moved group is preserved. Nothing is added, removed or
rewritten — only relocated. The second direction is the larger lever of the
two, and it is not about volatility at all.

`IRIS_CACHE_FRIENDLY=0` on the host turns it off for every conversation at once,
whatever each chat's setting says. With it off the assembly is **byte-identical**
to what it was before this feature existed (`cache-friendly.test.ts`, and
`assembly-determinism.test.ts` still holds).

### Why, and which of the two directions matters more

DeepSeek serves a cached prompt up to the **first changed byte** of the request
prefix, in 64-token blocks. Two separate losses follow from that, and they are
easy to conflate:

1. **Volatility.** One `{{roll}}` near the front of a world book does not cost
   its own size — it costs everything behind it. Three OVERLORD conversations
   in this profile cannot repeat their own request past **9.5%** of its bytes,
   and the first difference is a die-roll world-info entry in the system block.
2. **Rent.** Depth-anchored content is anchored to the *end* of the
   conversation, so its absolute position slides forward one exchange every
   turn. Two turns diverge at the newest floor, and every byte of depth content
   behind that point is re-sent in full and charged at miss price **even though
   it never changed**. `CACHE-CENSUS.md` §2.2 measures this: **100% of the rent
   in 11 real adjacent pairs is depth-anchored**, a mean of 6 381 tokens a turn
   over those pairs (two conversations), and 7 140 tokens a turn — 23% of the
   request — on 爱衣's own six stable pairs. Across 27 pairs, **60.8% of all
   unhittable bytes are byte-identical content**.

The second is the bigger number and it is invisible to any rule that only looks
for content that *changes*. It also has the opposite failure mode: promoting
content that turns out to move is worse than doing nothing — the four corpus
conversations whose depth bucket changes every turn go from 7.6%–55.2% down to
**0.0%–19.5%** if promoted. That asymmetry is why the mechanism promotes only on
*observed* stability, never on appearance, and it is `CACHE-CENSUS.md`'s explicit
constraint on this work ("搬位置之前必须先判定稳定性").

### Which parts move, and which do not

| placement | volatile | settled |
| --- | --- | --- |
| system section | **moved back** — it sits ahead of the whole conversation, so a volatile one costs the entire request | no move; it is already in the prefix |
| depth ≥ 1 injection | **moved back** — it sits *inside* the run two turns would otherwise agree on | **moved forward** |
| depth 0 injection | **stays** — it is already the last thing before the reply, so there is nowhere later to put it | **moved forward** |
| chat history | not a contribution — see "what this does not fix" | — |

Two departures from the brief, both because the geometry says so:

- **`CACHE-PREFIX.md` §3 提案 A's "never relocate depth content"** rests on
  「它们已经在新历史之后了」, which is true of depth 0 and false of depth 1 and
  deeper. So volatile depth ≥ 1 injections do move back.
- **Depth 0 is the one placement that moves in only one direction**: nowhere
  later to defer it to, but forward is the whole point.

**The loudest single cost is `post_history_instructions`.** A card's
post-history instruction and a preset's post-history section are placed as
depth-0 contributions, so a constant one is promoted like any other settled
depth content — and it is *named* for sitting after the conversation. That is
what `CACHE-CENSUS.md`'s counterfactual measured (it moved every depth-anchored
segment, n=9 on 爱衣, for 98.0%), so the mechanism matches the measurement
rather than carving out an exception the numbers never had. Pinned by name in
`cache-friendly-assembly.test.ts` so that if this is later ruled wrong, the test
says where the exception goes.

### How the classification is decided — a mechanism, not a list of entries

Four rules, in `packages/iris-app-service/src/cache-friendly.ts`, each weighted
by the evidence behind it. The first three decide *volatile*; the fourth decides
*settled*, and no id can be both — volatility is always the newer evidence.

1. **Measured.** The host keeps a content hash per contribution id for the
   previous assembly (in memory, and persisted in `chat_metadata` under
   `iris_cache_volatility`, an Iris-owned key — upstream has no equivalent).
   A different hash under the same id means that text changed. The mark then
   holds for 20 further generations, because *returning* to the prefix costs a
   full miss too and is not worth paying on a hunch.
2. **Runtime source.** Every live card-script `setExtensionPrompt` injection,
   re-asserted every generation so it never lapses. Not a reading of text: such
   a value is computed while the turn is prepared, so two turns agreeing is not
   evidence the third will — and since #17 a `'before'` injection lands at
   `main.order - 1`, ahead of the entire preset, where one change costs
   everything.
3. **Predicted**, on a contribution's *first* sighting only: its
   **pre-expansion** text carries a macro whose value provably moves
   (`{{random}}`, `{{roll}}`, the clock family, the floor-addressing family,
   `{{format_*_variable}}`) or an EJS template. The list lives in one place,
   `ENTROPIC_MACROS`, with its source named per line.
4. **Settled** — the id's *current* content has been observed at
   {@link DEFAULT_SETTLE_AFTER} = 2 consecutive assemblies and it carries no
   volatile mark. Two is small because the hold above already dominates:
   anything that ever changed is suppressed for 20 further generations, so this
   counter governs one case only — content that has *never* been seen to change.
   There the cost of waiting is a turn of rent and the cost of acting is one
   miss, and DeepSeek does not serve a prefix until it has seen it twice anyway
   (`CACHE-TARGET.md` §1.2: 「前两次请求不会命中缓存」), so the first two turns
   of a conversation were never going to hit.

The `since` clock that rule 4 reads restarts on every observed change, and — the
case worth naming — starts *now* rather than "forever ago" for a record written
by a build that had no such field. An id whose clock is simply missing has not
been observed holding still; it has not been observed at all.

The prediction needs text that no longer exists by assembly time, so
`buildPrompt` collects it while it still does (`PromptResult.entropic`), and
`@iris/lorebook` now keeps `PreparedEntry.source` — the entry's content before
the scan overwrites it with this turn's expansions. `source` is added *outside*
the object `PreparedEntry.hash` is taken over, deliberately: that hash keys the
persisted sticky and cooldown windows, and stirring a field into it would have
silently reset every timed window in every chat file on disk.

### Two rules that were wrong first, and what each cost

Both were found by measurement, not by review, and both are pinned by tests:

- **A broad prediction list.** `{{getvar}}` / `{{setvar}}` / `{{addvar}}` were on
  it. On the operator's own preset they fire on **136 of its 246 prompts**
  (`setvar` 70, `addvar` 56, `getvar` 15) — a preset uses them for its own
  internal switches, which answer the same string every turn. 37 of those
  rendered non-empty for a real generation and were moved, `main` among them,
  and 爱衣's measured ceiling went **from 72.2% down to 66.7%**. Moving stable
  text out of the prefix costs the prefix. After the narrowing the same preset
  predicts **1 of 246**.
- **A prediction worth one generation.** The idea was that a guess should not
  earn a measurement's hysteresis. What it produced was a *flapping layout*:
  assembly 1 moved a section, assembly 2 (now holding a hash) put it back, and
  two assemblies of one unchanged conversation agreed on **0.3%** of their bytes
  where the control had been 100%. A layout that changes is worse than either
  layout, so a prediction now holds exactly as long as a measurement.

### Interaction with the rest of the assembly

- **`squashSystemMessages`.** Upstream's squash merges adjacent system messages.
  A volatile message now never merges with a stable one **in either direction**
  (`driver.ts`'s `squashSystemRuns`). Merging rewrites the message that absorbs
  the other, so a moved segment merging into the message in front of it would
  reintroduce, one layer down, exactly the miss the reorder was performed to
  avoid. Volatile messages still merge with each other, and stable ones with
  each other.
- **The budget and history trimming are untouched.** The moved sections leave
  the system string, so `assemble` charges them as their own term. The total
  charge is deliberately the same either way — the reorder changes where text
  sits, never how much of it there is — so `trimHistory` drops the same floors,
  `firstIncludedMessageId` names the same floor, and #28's `iris_compaction`
  summary (which rides as pinned history) is unaffected. Pinned by a test that
  asserts equal `droppedHistory` and equal `tokens` with the flag on and off, on
  a fixture that really does trim.
- **`#summarize` and the card-facing side completion assemble with the reorder
  off.** The first extracts the system slot alone against an empty
  conversation — with the reorder on it would lose the moved sections
  entirely — and the second is a one-off with no prefix to preserve.
- **A preview never advances the classifier.** `classifyVolatility` returns the
  verdict and the next record separately; `prompt.itemize` takes the verdict
  only. Opening the prompt panel twenty times must not age every mark out of its
  hold and reshuffle the next real request.

### What it was measured to buy

`scripts/cache-friendly-probe.mjs`, 2026-09-08, on a read-only copy of the
operator's profile, comparing wire bodies through `serializeRequest`. No request
leaves the process. Three passes per conversation: off, on with an empty
classifier, and on seeded with **the record the cold pass itself learned**, its
clock rewound so nothing has lapsed — that third pass is the steady state, and
its seed is the product's own record written through the product's own writer.

**These are ceilings, not acceptance.** `CACHE-TARGET.md` §2 rules that
acceptance is the provider's own `prompt_cache_hit_tokens / prompt_tokens` over
ten consecutive included turns, per turn *and* in aggregate, excluding each
session's first two generations — and a gate that read ceilings alone would pass
while the hit rate never moved. A ceiling has exactly two sanctioned uses:
below 95% means the target is unreachable without sending anything, and a report
far below its own ceiling sends you to `CACHE-TARGET.md` §4.3 rather than back to
the assembler. Nothing here is a claim of 达标.

**Not comparable with `CACHE-PREFIX.md`'s 2026-09-07 table.** The corpus is live:
爱衣 has roughly doubled since (body 54 855 → 111 549 B, and its depth-0 block
5 367 → 16 498 B). Each table belongs to its own day.

爱衣, eight adjacent pairs (11→13 … 25→27):

| | off | on (steady state) |
| --- | --- | --- |
| mean ceiling | 72.2% | **88.9%** |
| range | 67.5% – 74.2% | **85.7% – 90.5%** |
| bytes re-sent verbatim behind the prefix, per turn | 24 981 | **8 223** |

Two conversations that could not repeat their own request, measured as
"same state assembled twice":

| conversation | off | on, defer only | on (steady state) | first difference remaining |
| --- | --- | --- | --- | --- |
| OVERLORD ×3 | **9.5%** | 41.1% | **65.1%** | `msg[8]`, a `{{roll}}` world-info entry |
| Sgw 又看一集 | 83.1% | 83.1% | **99.1%** | `msg[12]`, a `{{random}}` avatar table |

And the case the *defer* direction exists for — a card script injecting a value
that differs every turn at `position: 'before'`, which since #17 lands at
`main.order - 1`, ahead of the whole preset (`IRIS_PROBE_MVU=1`; four pairs,
19→21 … 25→27):

| 爱衣 | off | on (steady state) |
| --- | --- | --- |
| no injection | 73.9% | **89.9%** |
| with the per-turn injection | **0.4%** | **89.9%** |
| same state twice, with the injection | 0.3% | 92.2% |

The two numbers in the last column being equal is the result: the reorder makes
that injection **free**, which is `CACHE-CENSUS.md` §4.4's finding reached
independently (it measured the same move as 0.4% → 74.7% against a 74.9%
baseline).

The host's own reading agrees with the byte measurement without sharing any code
with it: `PromptItemization.stablePrefixTokens` reports 91.9% of 爱衣's newest
request as reusable where the byte-level pair ceiling is 88.6% – 90.5%. The gap
is history growth, which a single-request reading cannot see.

### What it does not fix, measured

**≥95% is not reached on 爱衣, and the shortfall is one identified block.**

1. **爱衣 stops at 88.9%, and 7.4 points of the remaining 11 are a single
   8 223-byte depth block** — the MVU status table, `{{format_message_variable::
   stat_data}}`. It is classified volatile, so it is not promoted, and that is
   the right call rather than a gap: `CACHE-CENSUS.md` §4.5 measures 爱衣's depth
   content as changing on **4 of 10** real transitions (world-info activation
   varies with the scan window at short history), and promoting it on a changing
   turn takes the ceiling to **5.2% – 6.2%**. Arithmetic on the newest pair: with
   that block promoted too the ceiling is **96.5%**, matching
   `CACHE-CENSUS.md`'s 98.0% synthetic figure; the difference between 88.6% and
   96.5% is exactly this one block. The rest — 1 282 to 13 397 B a turn — is
   genuinely new conversation and cannot be recovered by anyone.
2. **The next step is granularity, not policy.** *(Done in §50, and its reason
   for declining was avoidable — the split lives beside the contribution's text
   rather than in the contribution list, so the `cacheFriendly: false` path
   never reads it. Measured: +5.0 to +7.1 points on each of eight adjacent
   pairs, 87.8% → 93.9% at the mean. The
   paragraph is left standing because the argument it makes about the off path
   is the constraint §50 was designed against.)* That block is *one*
   contribution because `buildPrompt` joins a whole depth bucket into one, while
   the individual world-info entries inside it are byte-stable —
   `CACHE-CENSUS.md` §4.5 verified three of them (8 223 + 4 020 + 7 114 =
   19 357 B) byte-identical on the newest pair, and the bucket changes because
   entries *join and leave* it. Classifying per entry would let the stable ones
   promote and leave only the moving one behind. Not done here: it means one
   contribution per activated entry rather than one per bucket, which changes
   the `cacheFriendly: false` assembly too (N separate messages where there was
   one joined block), and that path must stay byte-identical. The same outcome
   is available to the user today with no code change — `CACHE-PREFIX.md` §3
   提案 C's `position` knob on the individual entries.
3. **OVERLORD's and Sgw's residual is a `{{roll}}` / `{{random}}` the card
   author wrote**, in a world-info entry. OVERLORD's is at `worldInfoBefore`
   (`CACHE-CENSUS.md` §5.1: 6 + 6 d20 re-rolled on every assembly, ~4 527
   tokens), so its ceiling is capped **regardless of history length** and the
   fix is the card's — moving the dice entry to depth 0, which is where a roll
   belongs anyway. Iris can only report it.
4. **A volatile depth ≥ 1 injection's lift is still unmeasured in isolation.**
   It fires, but in every corpus conversation a larger loss sits in front of it,
   so its own contribution to these numbers is 0. Kept on the geometric argument
   alone; named here as the part of this entry a reviewer may reasonably cut.
5. **Nothing here covers card-script-initiated generations.** They are not
   recorded in `iris_usage` (`CACHE-TARGET.md` §4.5), so every figure above and
   every figure in the acceptance run describes the user-visible turns only — a
   narrower population than the bill.

### One unrelated fix carried in this change

`#itemizationOf` was called without `window` when recording a real turn's
itemization (`service.ts`), so the stored record reported
`budget.context: 32768` for a chat that had just assembled against a 2 000 000
override, while the *preview* path passed the window and reported it correctly.
The panel's capacity line therefore changed meaning depending on which of the
two answered. Found by the census pass rather than by this package's tests:
every fixture here runs on the default window, where the two agree.

### Where a user sees it

The prompt panel's assembly-order view groups rows into the three phases the
request actually carries — promoted, in place, deferred — and marks each moved
row 「已前移（缓存友好）」 or 「已后移（缓存友好）」 with the position it came
from. The context card prints 「稳定前缀 约 X%」 beside the provider's own
cache-hit line, worded as an estimate because it is one.
`notes/apps/iris-web/DEVIATIONS.md` §67.

## 39. History is trimmed in blocks of floors, not one floor at a time — so the oldest floor the model sees holds still

**Kind: deliberate deviation, for prefix caching. Measured before and after.**

Upstream's budget trim keeps newest-first and stops at the first message that
does not fit (`openai.js:1061-1065` — `canAfford`, else `break`), rebuilding the
budget from scratch on every generation (`:1558`, a fresh `ChatCompletion` and
`setTokenBudget`). It remembers no boundary: the only stored artefact,
`chat_metadata.lastInContextMessageId`, is written by `setInContextMessages`
(`script.js:6041`) and read by two macro definitions and nothing else — a grep
over `public/**/*.js` finds no path back into `populateChatHistory`. So from the
first overflow to the end of the chat, **the oldest floor the model is shown
moves on every turn.**

Against a provider that serves a cached prompt only up to the first changed byte
of the request prefix, that is the worst shape a long conversation can have: the
conversation now starts one floor later than the cached copy does, so the whole
thing is re-billed, every turn, for as long as the chat lives. `CACHE-PREFIX.md`
§3's proposal C already named this the most expensive kind of loss in a long
chat; this is the measurement and the change.

**What Iris does instead.** `trimHistory` rounds the number of dropped floors
**up** to a multiple of `Budget.trimBlockFloors`
(`DEFAULT_TRIM_BLOCK_FLOORS = 8`, four exchanges; `trimBlockFloors` on the
`@iris/app-service` config row, `IRIS_TRIM_BLOCK` in `apps/iris/cordis.yml`,
`0` restoring upstream exactly). The count then has to climb a whole block
before the boundary moves again — about `block / 2` turns, since an exchange is
two floors — and while it does not move, the entire prefix ahead of the newest
exchange is byte-identical to the previous turn's. Two guards: a conversation
that still fits is never cut (the block is the price of a trim, not a standing
tax), and the drop is clamped so at least one trimmable floor always survives.

**The cost, named.** At the moment of a cut, up to `block - 1` floors the budget
could still have afforded are given up — the oldest ones, which is also the span
automatic compaction (§29, threshold 80% of the same budget) is meant to have
replaced with a summary long before the trimmer ever runs.

**The unit took a measurement to get right, and that is the part worth
remembering.** The first implementation expressed the block as a *share of the
token budget* and subtracted it before selecting, on the theory that the
leftover would be headroom. It is not: the selection adds floors until the next
one overflows, so whatever the target, the slack left behind is only the size of
the floor that did not fit — and the boundary advances on the next turn exactly
as before. Run against six adjacent rounds of the operator's own longest
conversation, that version was byte-for-byte indistinguishable from upstream.
The boundary is an **index**, so the quantum has to be an index.

**Measured** (`scripts/cache-history-probe.mjs`, 2026-09-08, 爱衣 at 27 floors,
`contextWindow` narrowed to 18 000 so the trimmer engages — at the product's
32 768 no conversation in this corpus is trimmed at all, because the world-info
budget is a percentage of the window and shrinks with it):

| | oldest sent floor moved | mean conversation ceiling | mean body ceiling |
|---|---|---|---|
| `trimBlockFloors: 0` (upstream) | **4 of 6 rounds** | 21.4% | 47.8% |
| `trimBlockFloors: 8` (default) | **1 of 6 rounds** | 27.8% | 54.7% |

With the block, the boundary held across four consecutive rounds (dropped count
16, 16, 16, 16) and the conversation's own prefix ceiling climbed turn by turn
as the held prefix accumulated — 17.6%, 20.6%, 23.5%, 26.2%. Without it, three
of the four comparable rounds start over from the pinned greeting at 12–13%.

**Threshold ordering, written down because the two mechanisms answer the same
pressure.** Compaction fires at `0.8 × (context − reserve)` (§29); the trim
fires when that same figure is reached in full, since `assemble` spends
`context − reserve − fixed` on history. So compaction always gets there first
and a block cut is the fallback rather than the plan —
`history-stability.test.ts`'s last test is where that ordering is asserted
instead of assumed. One gap is known and deliberately left alone:
`#autoCompact` reads the **previous** turn's itemization out of
`ChatEntry.itemizations`, which is in-memory, so the first generation after a
host restart cannot compact, and a conversation already over the threshold can
take one block cut before the compaction machinery has a reading to act on.

**What would overturn it.** A conversation where the block's over-trim costs
context the model visibly needed. The answer then is not a smaller block but an
earlier compaction, since the block only runs where compaction has already
failed to.

## 40. `script.generate` assembles under the chat's own window and squash, not the composition's defaults

**Kind: compatibility fix. Both halves were prefix breakers.**

`#sideGenerate` — the assembly behind a card's `TavernHelper.generate` — built
its budget from the composition's `contextWindow` rather than from the chat's
(`windowOf`, which prefers the active preset's `openai_max_context` and any
per-chat override), and never applied the chat's `squashSystemMessages`.
Upstream has no separate budget and no separate squash for a card's generate at
all: it goes through the same `Generate` → `prepareOpenAIMessages`, so it gets
the same `openai_max_context` and the same squash at `openai.js:1599`.

Both differences show up as one defect. A card's side call is meant to be a
genuine **prefix** of the conversation it belongs to — the same reasoning §29's
summarizer call is built on — and a call that trimmed at a different floor, or
that sent the same depth injections in a different shape, stops being one and
re-pays for the whole history. Pinned by two tests in
`history-stability.test.ts`. The window one is asserted on the *amount* of
conversation that comes back rather than on the first row, because the greeting
is pinned and row 0 survives every trim: the first version of that assertion
compared row 0 and stayed green with the fix reverted.

## 41. The squash separator was a blank line; upstream's is one newline

**Kind: compatibility fix, found while auditing the squash for cache safety.
Cache-neutral.**

`squashSystemRuns` joined merged system messages with a blank line. Upstream's
`ChatCompletion.squashSystemMessages` joins with a single newline
(`openai.js:3846`, `lastMessage.content += '\n' + message.content`) and keeps
the first message of the run, mutating it in place. Two adjacent injections were
therefore reaching the model spaced differently than the same two reach
SillyTavern's, which is a difference in the prompt and not only in the
whitespace. Corrected, with the citation; the driver test now spells the
separator as a literal so a later edit has to come to it and say why.

Three of upstream's other guards have no object here, and are recorded as absent
rather than dropped: it skips empty system messages (`:3836`, and
`injectAtDepth` already refuses a blank contribution), it skips messages
carrying a `name` (`:3841`, and no system-placed message in this pipeline has
one — `name` reaches only history entries, which are user or assistant), and it
exempts `newMainChat` / `newChat` / `groupNudge` (`:3828`), identifiers Iris
does not mint.

**The squash does not endanger the prefix, and that is measured rather than
argued.** Six adjacent rounds of 爱衣 assembled with the squash off and then on
gave the same common-prefix byte counts to the byte (73 985 / 75 350 / 77 180 /
78 334 / 79 695 / 81 610), and the request-size difference between the two was a
constant 189 B on every round. The reason is structural: every message the
squash can merge is either the compaction summary at the head or a depth
injection, and a depth injection sits a fixed distance from the **end** of the
conversation, so the merge point cannot wander into text a previous request had
already sent.

## 42. The continue separator rides on the request; upstream's rides only on the recorded reply

**Kind: deviation, pre-existing, now measured and documented rather than
changed. The code comment claiming it was upstream's behaviour was wrong.**

`TurnDriver` appends `continue_postfix` to the last assistant message of the
**request**, so the model is asked to continue text whose boundary it can see.
Upstream does not. It appends the postfix to `cyclePrompt` and to `continue_mag`
(`script.js:4916-4921`), and both are output-side: `continue_mag` is prepended
to the reply it records (`:5346`, `:5452`) — which is what Iris's composite
candidate does too, so the **stored** floor matches upstream — while
`cyclePrompt` reaches the request only through the continue nudge's
`{{lastChatMessage}}` macro, where `String(cyclePrompt).trim()` strips the
separator straight back off (`openai.js:902`). The request's own copy of the
continued text comes from `coreChat[…].mes` and carries no postfix.

Left as it is, for two reasons. The cache cost is one separator's worth of bytes
at the newest floor, which is past the prefix either way — and the behaviour is
arguably better, which is the §"Iris is an upgrade" case rather than a
compatibility one. But it is a deviation and the driver's comment presented it
as parity, so both the comment and this entry now say which half of upstream's
postfix handling Iris matches and which it does not. Pinned in
`history-stability.test.ts` so the deviation cannot drift silently in either
direction.

## 43. Measured, not changed: no already-sent floor is ever re-rendered — every mid-conversation divergence is a depth injection moving

**Kind: audit result. The instrument is the finding.**

An adjacent-round ceiling says *where* two requests diverge. It does not say
whether the divergence is the tail growing (expected, and unavoidable) or an
older floor being rendered differently on the newer turn — which would be a
defect, and the one the history side owns. Those two have opposite fixes and the
byte offset alone cannot tell them apart: on the operator's own longest
conversation the two adjacent requests stop agreeing about 20 KB into a 46 KB
conversation, which reads like a floor changing in the middle.

`scripts/cache-history-probe.mjs`'s `floors` section discriminates. It aligns
the two message lists from the front, then looks for the older request's first
non-matching message **anywhere** in the newer one, and classifies:

- `grew` — every message of the older request is still there, byte-identical,
  and the newer one only added to the end;
- `moved` — the older text is present at a different index (a depth injection
  sliding as the conversation grows);
- `rewritten` — the older text appears nowhere; something re-rendered a floor
  that had already been sent.

**Result on 爱衣, 2026-09-08, four adjacent rounds (19→21, 21→23, 23→25,
25→27 floors): zero `rewritten` floors.** The shared head covers every
already-sent floor on every round (18, 20, 22, 24 messages), and the first
divergence is in all four cases the first **depth injection** — the same
~4 785-character block, three times `moved` to a later index by exactly the
number of messages that round added (18→20 head with the text found at 22,
20→22 at 24, 22→24 at 27), and once with its own content changed by a single
character between the two rounds (4 784 vs 4 785). Its content moves because the
block holds a live variable table and, in this book, a `{{lastUserMessage}}`:
measured over the same profile, 1 of 18 world books uses a per-turn floor macro
(`[SG]可攻略女主拒绝被攻略` uid 21) and 0 use `{{lastMessage}}`,
`{{lastCharMessage}}`, `{{lastMessageId}}` or `{{firstIncludedMessageId}}` —
and that one entry is `position: 4, depth: 0`, so it sits after the newest floor
where the prefix has already ended and it costs nothing extra.

So the history projection contributes **no** mid-conversation churn: not the
naming (`serializeMessages` sends no `name` field and `toMessage` coerces every
mid-conversation role the same way on every path), and not the prompt-direction
regex depths either — which was the specific hypothesis worth checking, since
`#rawHistory` recomputes each floor's `depth` from the conversation's length on
every generation, so a depth-scoped script would re-render an older floor as it
aged. Measured: none of these floors changes.

The loss the ceiling actually reports is the geometry of depth anchoring
(`CACHE-PREFIX.md` §3 proposal B): a block anchored a fixed distance from the
end moves forward every turn, and everything from it onwards is re-sent and
re-billed verbatim. That is not a history-side defect and is not fixable from
here.

**What would overturn it.** A `rewritten` row on any conversation. The probe
prints the first differing character with 60 characters of context on each side,
so the next reading names the floor and the script that touched it rather than a
byte offset.

## 44. The context window is clamped to the model's, on every read rather than by overwriting the setting — and the model's window is learned from the endpoint before any table

**Kind: deliberate improvement.** It was written as "a compatibility gap
closed" until the user's own SillyTavern settings were read — see the
correction after the upstream table. Upstream's clamp exists, but not on the
route this host has.

### What was reported, and where the number came from

A conversation running `deepseek-v4-flash` was assembling against a window of
2 000 000 tokens. The capacity card printed 1 998 976 — which is that window
minus the 1 024-token reply reserve — under a model DeepSeek documents at 1M.

The number was not read from anywhere clever. `windowOf` was
`settings.contextWindow ?? fallback`, and `settings.json` on the reported
install carries:

```
/global/model          = "deepseek-v4-flash"
/global/contextWindow  = 2000000
```

`/global/contextWindow` was written by `presetScalarPatch`, which maps a
preset's `openai_max_context` onto the **global** settings layer. And the
active preset asked for it — `/preset/name` is `[主预设] V19.5 狐神抚 · 毓忻`
and `/preset/body` carries both keys:

```
openai_max_context   = 2000000
max_context_unlocked = true
```

*(An earlier draft of this entry called the 2M a residue left by a preset
switched away from, on the strength of the other preset in the profile —
`咩咩预设 - ver 5.8.1`, which genuinely carries no `openai_max_context`. That
was wrong: the 2M preset is the active one, `/chats` is `{}` so no per-chat
override is involved, and the simpler reading was on the file the whole time.
Recorded rather than deleted because the wrong version changed what the fix
looked like — see the note on `contextUnlocked` below.)*

Two facts about that pair are worth stating separately, because only one of
them is upstream's doing:

- **2 000 000 is exactly upstream's `unlocked_max`** (`openai.js:137`,
  `max_2mil`). A preset carrying that number was saved by someone whose slider
  bound *was* 2M, which is what the same file's `max_context_unlocked: true`
  bought them.
- **This host read the number and ignored the flag.** `max_context_unlocked`
  appeared nowhere in the tree before this entry.

**What that means for the reported conversation, stated plainly because it is
not the obvious answer.** Once the flag travels (below), applying that preset
writes `contextUnlocked: true`, and `resolveWindow` then takes its `'unlocked'`
branch: the window is **2 000 000 again, deliberately, and the card says
「窗口 2M，未夹 —— deepseek-v4-flash 已知只到 1M」** instead of saying nothing.
That is the compatible answer — it is what the preset asks for and what
upstream does on this route — and it is not what the user asked for. The clamp
they want is one switch away, and the switch is now in the drawer and named.
Today the profile clamps to 1M only because `/global/contextUnlocked` is still
absent: the preset was applied before the flag existed. Nothing here silently
reinstates the 2M; the first preset re-apply does, visibly.

### Upstream

Upstream decides the window entirely at **settings/UI time**, never at request
time. `onModelChange` (`openai.js:5346`) runs on every model change and, two
hops away through `$('#chat_completion_source').trigger('change')` → the source
handler (`:6832-6842`) → `toggleChatCompletionForms` (`:5974`), at init
(`:4303`), on preset apply when the preset is bound to the connection
(`:4947`), and on the unlock toggle (`:6847`).

**That last one is gated, and the gate is the case this host models.**
`:6846` is `if (data?.source !== 'preset')` — so when the unlock checkbox is
moved *by a preset* (`updateCheckbox` passes `{source: 'preset'}`, `:4908`),
upstream deliberately does **not** re-clamp. Upstream re-clamps on a *user*
toggle only, which is exactly the path `presetScalarPatch` now reproduces.

Every source branch is the same two steps — set the slider's `max` attribute to
the model's maximum, then

```js
oai_settings.openai_max_context = Math.min(<attr max>, oai_settings.openai_max_context)
```

DeepSeek's branch, in full (`openai.js:5756-5761`):

```js
if (oai_settings.chat_completion_source === chat_completion_sources.DEEPSEEK) {
    const maxContext = oai_settings.max_context_unlocked ? unlocked_max : max_1mil;
    $('#openai_max_context').attr('max', maxContext);
    oai_settings.openai_max_context = Math.min(Number($('#openai_max_context').attr('max')), oai_settings.openai_max_context);
```

At generation time there is **no** re-check: `prepareOpenAIMessages` passes
`oai_settings.openai_max_context` straight into `setTokenBudget`
(`openai.js:1558`, `:3887`) with no bounding at all. So upstream's clamp is a
write, and any value that slips past the write is used verbatim — an unbound
preset load is exactly such a path (`:4936-4948` assigns the raw preset value
*after* the browser-clamped `updateInput`, and only re-clamps when
`bind_preset_to_connection`).

Where upstream gets the per-model maximum varies by source, and both kinds
matter here (SillyTavern 1.18.0, read 2026-09-08):

| source | how the maximum is found |
| --- | --- |
| OpenAI / Azure | `getMaxContextOpenAI`, a 15-row regex table (`:4973-4987`, inside `contextMap` at `:4972-4988`), falling back to `max_128k` |
| DeepSeek | flat `max_1mil`, no per-model table (`:5756`) |
| Claude | inline regex if/else, 1M or 200k (`:5604-5616`) |
| OpenRouter, Mistral, Groq, Moonshot, Fireworks, Chutes, ElectronHub, NanoGPT, AIMLAPI, Workers AI, Gemini | read off the **provider's own model list**, under eleven different names: `context_length`, `max_context_length`, `context_window`, `inputTokenLimit`, `properties[].property_id === 'context_window'`, `info.contextLength`, and — ElectronHub, `:5318-5319` — plain `tokens` |
| Custom | always `unlocked_max` |

`max_context_unlocked` short-circuits 23 of those 24 branches to `unlocked_max`
(2 000 000). It does not remove the bound; it raises it, and the `Math.min`
still runs. The exception is MiniMax (`:5869-5871`), which never reads the flag
— its ceiling is a ternary on the model name. What MiniMax skips is the
*unlock*, not the clamp: the `Math.min` claim above holds for every branch.

**Correction, and it changes what kind of entry this is.** The last row of that
table is the one that applies to the reported install. Measured on the user's
own SillyTavern (`E:/sillyTavern/SillyTavern/data/default-user/settings.json`):

```
oai_settings.chat_completion_source = "custom"
oai_settings.custom_url             = "https://api.deepseek.com"
oai_settings.custom_model           = "deepseek-v4-flash"
oai_settings.openai_max_context     = 2000000
oai_settings.max_context_unlocked   = true
```

They are on the **CUSTOM** source, not the DeepSeek one, and upstream's CUSTOM
branch is (`openai.js:5704-5710`, in full):

```js
if (oai_settings.chat_completion_source == chat_completion_sources.CUSTOM) {
    $('#openai_max_context').attr('max', unlocked_max);
    oai_settings.openai_max_context = Math.min(Number($('#openai_max_context').attr('max')), oai_settings.openai_max_context);
```

No model table, no `max_context_unlocked` check — the bound is 2 000 000
unconditionally. So **upstream would not have clamped this conversation
either.** 2M under a 1M model is what SillyTavern does for an endpoint it was
handed as a URL, and the user's preset was saved in exactly that state.

That matters twice. It means this entry is a **deliberate improvement**, not a
compatibility fix — the clamp is borrowed from upstream's *named* source
branches and applied to a route upstream leaves unbounded. And it means the
route shape decides everything: this host has one route, an OpenAI-compatible
endpoint with a base URL and a model name, which is structurally always
upstream's CUSTOM case. There is no source constant here to switch on, so the
choice is between "never clamp" (upstream's answer for this route, and the
reported bug) and "clamp on what the model id and the endpoint can tell us"
(this entry). `contextUnlocked: true` is what hands the first answer back, and
it is exactly upstream-on-CUSTOM.

### Iris

**`resolveWindow`** (`src/model-context.ts`) is the one place the window is
decided, and every caller goes through it — `#chatBudget` for the view, and the
three assembly sites that used to call `windowOf` directly. The rule:

1. no stored `contextWindow` → the host composition's value, `source: 'host'`
2. stored value ≤ the model's known window, or the model unknown → the stored
   value, `source: 'settings'`
3. `contextUnlocked: true` → the stored value, `source: 'unlocked'`
4. otherwise → the model's window, `source: 'model'`

**Two deliberate differences from upstream.**

*The clamp is a reading, not a write.* Upstream overwrites
`openai_max_context` with the smaller number, so a user's 2 000 000 is
destroyed the moment they touch a 1M model and does not come back when they
unlock. Here the stored value is untouched and the clamp is applied on every
resolution, so unlocking restores exactly what they asked for. Pinned:
*the stored window is left alone — the clamp is a reading, not a write*.

*The unlock removes the bound instead of raising it to 2 000 000.* This host has
no 2M ceiling of its own, and borrowing upstream's would cap a future 4M model
at a 2026 constant. What is left is one ceiling, `MAX_CONTEXT_WINDOW` =
4 000 000, and it is a bound on *credulity* rather than a capability claim.

**That ceiling now lives in `@iris/protocol`, and it had to move.** Three
layers check it — the settings store bounds what a person may type, the probe
bounds what an endpoint may report about a model, and `connection.save`'s zod
schema bounds what crosses the wire — and the third is not host-side, so a
constant in the host could only be *restated* there. It was, and the two had
already diverged from a third: the settings drawer's own slider capped a person
at **2 000 000**, which is upstream's `unlocked_max` verbatim, so the paragraph
above argued against a bound this feature's only input control was still
imposing. All three now read one constant, and a test asserts it — store,
wire, and the slider's bound read out of `SettingsDrawer.tsx`'s source.

**`max_context_unlocked` now travels with `openai_max_context`.**
`presetScalarPatch` maps it to `contextUnlocked`, `false` as deliberately as
`true` — a preset saying "clamp me" has said something, and leaving a previous
preset's unlock standing would make the window depend on the order presets were
switched in.

Reading the number and dropping the flag is what let a 2M window be in force
under a 1M model with nothing said about it — upstream's slider could not have
*reached* 2M without the flag. But note what carrying it does on the reported
profile, because it is the opposite of what "fix" suggests: that preset asks to
be unclamped, so the window goes back to 2 000 000 and the card prints
「窗口 2M，未夹 —— deepseek-v4-flash 已知只到 1M」. The gain is not a smaller
number; it is that the number is now attributable and one switch away from the
1M the user wanted. Pinned: *the reported install's own preset resolves to an
unclamped 2M, and the card says which* — which also exercises the whole chain
(the preset's two keys → `presetScalarPatch` → `settings.set` → the view), so
the patch silently dropping the flag would be red.

**Where the model's window comes from**, in order:

1. **What an endpoint reported to a probe in this process.** `connection.test`
   used to reduce each `/models` row to a bare id string, discarding every other
   field. It now also reads a context length off the row —
   `CONTEXT_LENGTH_FIELDS`, five paths, each annotated with the provider whose
   documentation spells it that way and the date that page was read:
   `max_model_len` (vLLM), `context_length` and `top_provider.context_length`
   (OpenRouter), `max_context_length` (LM Studio), `meta.n_ctx_train`
   (llama.cpp). Three names that circulate but no surveyed provider documents —
   `context_window`, `max_input_tokens`, `max_tokens` — are deliberately **not**
   probed, and so is `loaded_context_length`, which appears only in third-party
   issue threads. Two documented sources are missing only because this host's
   probe never requests the endpoint they live on: LM Studio's
   `/api/v1/models` → `models[].loaded_instances[].config.context_length`, and
   Ollama's `/api/show` → `model_info["<general.architecture>.context_length"]`.
   Both need a second request per model. (Upstream reads none of these
   server-side either; its OpenRouter block in
   `src/endpoints/backends/chat-completions.js:2031-2043` builds a
   `context_length` map and then discards it, having already sent the response.)

2. **The built-in table**, `MODEL_CONTEXT_TABLE`. DeepSeek's own documented
   `/models` row is `{id, object, owned_by}` and nothing else
   (api-docs.deepseek.com/api/list-models, read 2026-09-08), so for this
   provider a probe learns nothing and never will — the table is the only
   answer there is. Its DeepSeek rows: `deepseek-v4-flash` /
   `deepseek-v4-pro` / `deepseek-v4-flash-vision-exp` → **1 000 000**, from
   DeepSeek's own Models & Pricing page (CONTEXT LENGTH `1M`, MAX OUTPUT
   `384K`, read 2026-09-08). The page writes "1M" and gives no exact integer, so
   this is 1 000 000 rather than 1 048 576 — the same reading upstream takes
   (`max_1mil = 1000 * 1000`). Every other `deepseek-*` id gets 1 000 000 too,
   sourced to upstream's flat DeepSeek branch, because `deepseek-chat` and
   `deepseek-reasoner` have left DeepSeek's pricing page entirely and upstream's
   answer is the only documented one left. The OpenAI and Claude rows are
   transcribed from `openai.js` with their line numbers and **in upstream's
   order**, because the order decides real answers (`/gpt-3\.5-turbo-1106/`
   before `/gpt-3/`).

3. **Nothing.** An unknown model returns `undefined` and clamps nothing.
   Upstream's fallbacks are deliberately *not* transcribed: `// Safe default
   for most modern models` / `return max_128k;` (`openai.js:4996-4997`, two
   lines) would silently cut every model
   released after this file was written down to 128k, which is the failure mode
   a made-up number always has. Pinned: *a model the table has never heard of
   returns undefined, not a safe default*.

**Two scoping decisions inside step 1.** A probe's readings are kept in a
process-local map keyed by model id (`#probedContexts`), not read back off the
saved profiles — a chat's settings name a model, never the connection it came
from, so "profile X said this id is 128k" cannot be attributed to a chat that
may be generating through a different endpoint. And only `'provider'` entries
are cached; caching a `'table'` lookup would be keeping a stale copy of a
constant. A fresh start therefore answers from the table until something probes,
which is the right way round: the table cannot be stale about a model it names,
while a persisted observation can be stale about an endpoint that has since been
reconfigured.

**One thing the endpoint's answer is allowed to do that the table is not.** A
serve running `deepseek-v4-flash` behind a shorter window — a proxy, a quantised
local copy — is telling the truth about itself, and a constant compiled in
months ago is not in a position to overrule it. Pinned: *the endpoint's own
answer wins over the table*.

**What `provider` could not be.** The brief for the table asked for
provider + model. This host's `GenerationSettings.provider` is the cordis route
name a request generates through — `'default'` on the reported install — not a
vendor, and a chat's settings carry no link to the connection profile that was
active when they were written. So the model id is the whole key, which is also
what upstream's own tables match on inside a source branch. One consequence:
the lookup folds case, which upstream never has to (its regexes run against
whatever its own `<select>` stored).

**One existing per-model window is deliberately not consulted.**
`@iris/llm-openai-compat`'s `ModelEntry.contextWindow` already exists and
`resolveModel` already returns it — but `apps/iris/cordis.yml:49-51` seeds
exactly one entry, `{ id: IRIS_MODEL ?? 'local-model', contextWindow: 32768 }`.
On a host launched with `IRIS_MODEL=deepseek-v4-flash` that row would assert a
32 768-token window for a 1M model, and wiring it in would have clamped the
reported conversation to 32k — a worse wrong answer than the one being fixed.

**Tests.** `tests/model-context.test.ts` (22) covers the table (prefix, case,
unknown, upstream's ordering, every row carrying a dated source), the row reader
(each documented spelling, the ranked order, a present-but-null field), the four
clamp branches, the preset flag, and the whole thing through the service —
including that the assembler and the capacity readout divide by the same number.
`tests/connections.test.ts` adds six over a real `node:http` `/models` endpoint,
including that a probe's reading reaches a chat's budget with nothing being
saved.

**Where this meets §36–§43.** `resolveWindow` is now the only thing that decides
a window, which those entries depend on more than this one does: `#budget`
(§40's shared builder), the cache-friendly assembly's own call, the card's
`script.generate`, the preview, and the recorded itemization all read it, so the
trace a divergence report reads describes a request assembled against the same
number the capacity card divides by. The record-side window bug §36's census
pass found is the same one this pass found from the clamp side — recorded twice
in `service.ts`, because a defect two independent readings converge on is worth
more than either reading.

## 45. The continue nudge and the impersonation prompt come from the preset, not from a constant — and `continue_prefill` cancels the nudge entirely

**Kind: compatibility fix, plus a remaining gap.** Found by a field-level audit
of the Chat Completion preset against `openai.js`'s `settingsToUpdate`
(`openai.js:298-403`, 102 keys), prompted by the operator's report that "a
preset seems less effective here than in ST".

**Upstream.** Both prompts ride in the preset file like any other field —
`impersonation_prompt` at `openai.js:357`, `continue_nudge_prompt` at `:362` —
and a preset switch overwrites `oai_settings` from them. So the preset's text
*is* the value; the shipped constants (`openai.js:104`, `:110`) are only what an
untouched install happens to hold.

Three details are load-bearing:

1. **The nudge is suppressed by `continue_prefill`.** The guard is
   `if (type === 'continue' && cyclePrompt && !oai_settings.continue_prefill)`
   (`openai.js:898`). With prefill on, upstream displaces the reply being
   continued to the end of the request and hands it back as the model's own
   opening words (`openai.js:1311-1318`); no instruction is added, because the
   position *is* the instruction.
2. **The nudge is a system message.** The `continueNudge` promptObject declares
   `role: 'system'` and `system_prompt: true` (`openai.js:899-903`).
3. **An empty string is a value, not an absence.** Upstream guards
   `impersonation_prompt` explicitly (`openai.js:1362`) — a preset that blanks
   the field sends no instruction.

**Iris, before.** `CONTINUE_NUDGE_PROMPT` and `IMPERSONATION_PROMPT` were
constants, with a docblock saying "this host has no settings surface for them
yet, so the defaults stand in until one exists". The premise had stopped being
true: `SettingsStore.presetBody()` holds the whole preset, so the values were in
memory the whole time. The nudge also rode as `role: 'user'`, cited in
`driver.ts` to `openai.js:899-904` — the very lines that say `role: 'system'`.

**Iris, now.** `utilityPromptOf` reads the field off the active preset and falls
back to the shipped default only when the key is **absent**; `''` sends nothing.
The nudge is suppressed when `continue_prefill` is `true`, and rides as
`system`.

**Measured, on the two presets in the operator's profile:**

| field | `[主预设] V19.5 狐神抚 · 毓忻` | `咩咩预设 ver 5.8.1` |
| --- | --- | --- |
| `continue_nudge_prompt` | 456 chars, custom (`[CONTINUE MODE — PURE EXTENSION]…`) | 68 chars — byte-identical to upstream's default |
| `continue_prefill` | `true` | absent |
| `impersonation_prompt` | 457 chars, custom (`[IMPERSONATION MODE — ABSOLUTE OVERRIDE]…`) | 210 chars, custom |

So for the preset the operator actually runs, every **continue** used to carry a
generic one-line nudge as a user message where upstream carries **no nudge at
all**, and every **impersonate** carried upstream's stock paragraph instead of
the preset's 457-character override. Both are now the preset's own words.

### The part that is still a deviation

Five more utility prompts ride in a preset and are still unread:
`send_if_empty` (`openai.js:356`), `new_chat_prompt` (`:358`),
`new_group_chat_prompt` (`:359`), `new_example_chat_prompt` (`:360`),
`group_nudge_prompt` (`:365`). **Measured impact on the operator's presets:
zero** — `send_if_empty`, `new_chat_prompt`, `new_group_chat_prompt` and
`new_example_chat_prompt` are all `""` or absent in both files, and
`group_nudge_prompt` is upstream's default and applies only to group chats,
which this host does not have. They are listed because "reads none of them" and
"reads none of them and it happens not to matter for these two files" are
different claims, and only the second is true.

### `{{original}}` in a card's prompt override

Carried in the same change. Upstream lets a card **extend** the preset's main
prompt rather than replace it: the replaced text is supplied to the substitution
as `original` (`openai.js:1491-1492` reaching
`PromptManager.js:1281-1284`), so a card writing `{{original}}` followed by its
own rules keeps the preset's prompt and appends to it. `applyCardOverrides`
replaced the content and never supplied `original`, so `@iris/macro`'s
`original` builtin yielded `''` and the preset's whole main prompt vanished —
silently and totally.

**Measured: 0 of 33 cards** across the two local profiles use `{{original}}`,
and only 1 of 33 carries a non-empty `system_prompt` at all. This is therefore a
correctness fix with **no measured effect on the present corpus**, kept because
the failure mode is silent and total rather than because anything here exercises
it. The fix resolves the macro at the substitution site — which is where
upstream resolves it — rather than by widening the turn's macro context, because
`original` is the only macro whose value differs per prompt item while the
context that expands the preset is built once per turn.

Not gated on `prefer_character_prompt` / `prefer_character_jailbreak`
(`power-user.js:203-204`): both ship `true`, neither rides in a preset file, and
this host has no settings surface for them, so applying the override
unconditionally is upstream's default behaviour.

## 46. The request body carries eleven of the preset's fields; upstream's carries twenty-one

**Kind: measured gap, deliberate for now.**

Upstream's `generate_data` (`openai.js:2742-2767`) is a request to **its own
backend**, which then builds the provider call. Some of its keys therefore never
reach a provider at all and are not gaps: `type`, `chat_completion_source`,
`user_name`, `char_name`, `group_names`, `reverse_proxy`, `proxy_password`,
`custom_prompt_post_processing`. `@iris/preset`'s `parity.ts` carries that
allow-list so a parity report does not open with a dozen false findings.

What is left, against `serialize.ts`:

| upstream body field | preset key | Iris | value in the operator's fox preset |
| --- | --- | --- | --- |
| `temperature` | `temperature` | sent | 1 |
| `max_tokens` | `openai_max_tokens` | sent | 65535 — **and it does reach the wire**, so short replies are not this |
| `top_p` | `top_p` | sent | 0.88 |
| `frequency_penalty` | `frequency_penalty` | sent | 0 |
| `presence_penalty` | `presence_penalty` | sent | 0 |
| `top_k` | `top_k` | sent | 40 |
| `min_p` | `min_p` | sent | 0 |
| `repetition_penalty` | `repetition_penalty` | sent | 1 |
| `seed` | `seed` | sent when non-negative | −1, upstream's "random"; dropped, see `serialize.ts` |
| `reasoning_effort` | `reasoning_effort` | sent | `"low"` |
| `stream` | `stream_openai` | always `true` | `true` |
| `logit_bias` | `bias_preset_selected` + `bias_presets` | **not sent** | `"Default (none)"`, and `bias_presets` is absent — the selected preset is the empty one, so upstream's field would be `undefined` too |
| `n` | `n` | **not sent** | 1 — upstream also omits it unless multi-swipe is on |
| `include_reasoning` | `show_thoughts` | **not sent** | `true` |
| `enable_web_search` | `enable_web_search` | **not sent** | `false` |
| `verbosity` | `verbosity` | **not sent** | `"auto"` |
| tool definitions | `function_calling` | **not sent** | `true` |
| — | `top_a` | **not read** | 0 |
| — | `max_context_unlocked` | **not read** | `true`; this host's window is a setting, not a checkbox |
| — | `names_behavior` | **not implemented** | `0` = DEFAULT |

**`names_behavior` is the one that reads worse than it is.** The enum is
`{ NONE: -1, DEFAULT: 0, COMPLETION: 1, CONTENT: 2 }` (`openai.js:204-209`).
`CONTENT` prefixes the speaker's name onto every non-narrator message's content
(`openai.js:594-598`) and `COMPLETION` sets the wire `name` field
(`openai.js:948-951`); this host does neither. But `DEFAULT` — the shipped
value, the value in **both** of the operator's presets, and the value in the
local ST install's own `oai_settings` — adds a prefix only for a group chat or a
message carrying `force_avatar` (`openai.js:589-593`). For a one-to-one chat,
`DEFAULT` and "no prefix at all" are the same request. So the gap is real for a
preset that sets 1 or 2, and **exactly zero** for every preset measured here.

The rest are omissions of fields whose measured values are either the provider's
own default (`n: 1`, `enable_web_search: false`, `verbosity: "auto"`) or without
an addressee on this host (`function_calling`, `logit_bias` with no bias
preset). `show_thoughts: true` is the one with a visible consequence — upstream
asks its backend to pass reasoning through — but this host reads reasoning off
the stream directly, so there is nothing to ask.

`top_a` is skipped in `presetScalarPatch` because `GenerationSettings` has no
field for it. Value `0` in the one preset that carries it, which is off.

### Carried in this change

`presetScalarPatch` also reads **`squash_system_messages`** now. It is a
checkbox in `settingsToUpdate` (`openai.js:380`) and a preset carries it like
any other field; the numeric loop's `typeof value === 'number'` guard silently
dropped it, so switching presets left the previous preset's squash running over
the new preset's prompt list. The operator's fox preset ships `false`
explicitly, 咩咩 omits it.

## 47. A preset's own regex scripts are not run — three tiers exist upstream, two here

**Wired on 2026-09-09; the landing is §53.** This entry stays as written because
it is the *measurement* — the 40 rules, the 18 live ones, the six that rewrite
the request, the two separators with an empty pattern, the four preset names on
the local install's allow-list — and §53 implements the recommendation its last
section makes rather than replacing it. Everything below was true of this host
until that round: the tier now runs, behind an allow-list of its own, off until
the user asks.

**Kind: unimplemented feature, with a measured surface and an upstream gate that
changes the recommendation.**

**Upstream.** `getRegexScripts` walks three tiers —
`SCRIPT_TYPES = { GLOBAL: 0, PRESET: 2, SCOPED: 1 }`, iterated by key insertion
order so the run order is global, preset, character
(`extensions/regex/engine.js:11-16`, consumed at `:99`; §35 is the correction
that got that order right here). The preset tier reads
`presetManager.readPresetExtensionField({ path: 'regex_scripts' })`
(`engine.js:126`) — the active preset file's own `extensions.regex_scripts`.

**Iris.** `scriptsOf` (`regex.ts:100`) builds the global and character tiers.
Its docblock said the preset tier "stays reserved — upstream reads it from the
active preset file's own `regex_scripts` field, which this host's read-only
preset library does not carry". **That premise is false**: the switched-in preset
body is stored whole, `extensions` included, and the operator's live
`settings.json` holds 40 scripts under
`preset.body.extensions.regex_scripts` right now.

### Measured surface, `[主预设] V19.5 狐神抚 · 毓忻`

40 scripts, 18 not disabled. Split by the stage each acts on
(`markdownOnly` = display only, `promptOnly` = the request only):

| | count | what they do |
| --- | --- | --- |
| enabled, `promptOnly` | 6 | strip `<think_fox>`, `<draft>`, `<fox_front>`, `<fox_selc>`, `<fox>` and `<fox_input>` blocks out of the text **sent to the model** |
| enabled, `markdownOnly` | 12 | the thinking-chain and action-option prettifiers — replaceStrings of 25 299, 41 831 and 21 412 chars |
| disabled | 22 | alternate skins, and the "kill LLM tics" family |

The six `promptOnly` ones are the fidelity-relevant half: without them every
turn feeds the model's own scaffolding, drafts and option blocks back into the
history it reads. The twelve `markdownOnly` ones are the *visible* half — a user
running this preset in ST sees a rendered thinking panel and sees raw tags here
— and they change no byte of any request.

Two of the 40 are UI separators with an **empty** `findRegex` and
`disabled: false`, which any implementation has to survive.

The preset stores the same 40 scripts twice more: in
`extensions.SPreset.RegexBinding.regexes` (a third-party extension's own copy)
and inside a 204 091-char `SPresetSettings` pseudo-prompt smuggled into
`prompts[]`. Only `extensions.regex_scripts` is upstream's field.

### The gate that changes the recommendation

`getScriptsByType` refuses the preset tier unless the preset is allow-listed:
`extension_settings.preset_allowed_regex[getCurrentPresetAPI()]` must contain
the preset's name, and `getRegexedString` is the caller that passes
`allowedOnly: true` (`engine.js:126-128`, `:346`). In the local ST install that
list holds four preset names — `Antennae_v16_α (1) (1)`, `Kemini 5.17 (1)`,
`Antennae_v18 (1)`, `Kemini 5.17 (5)` — and **neither of the operator's two
presets is on it**.

So on the evidence in this install, ST would not run those 40 scripts either,
and "ST is more effective because it runs the preset's regex" is **not
established**. What is established: the capability is missing, and the surface it
would cover is large. Those are two different claims and only the first is a
fact about Iris.

Wiring it therefore needs a policy decision rather than a parameter: the tier
must arrive **off** by default with a per-preset allow-list of its own,
mirroring `ScopedRegexPolicy`, or a user importing a preset silently gains 18
rewrite rules over their transcript. That is why this is listed rather than
fixed here.

`咩咩预设 ver 5.8.1` carries no `regex_scripts` at all, so this entry is one
preset's exposure and not a corpus statistic.

## 48. Every system-placed contribution is one system message; upstream sends one message per prompt

**Kind: framing deviation, effect unmeasured, recorded because every parity
report will show it.**

Upstream's Chat Completion path builds a flat `messages[]` in which each enabled
prompt becomes its own message carrying its own role (`Message.fromPromptAsync`,
collected by `ChatCompletion`), and merges adjacent system ones only when
`squash_system_messages` is on. `assemble.ts:165` joins this host's
system-placed contributions with a blank line and `serialize.ts:64-67` emits the
result as a single `{ role: 'system' }` message.

**Measured on the operator's presets**, enabled prompts in the chat-completion
order group, split by position and role:

| | fox V19.5 | 咩咩 5.8.1 |
| --- | --- | --- |
| pre-history, system, non-empty | 20 | 55 |
| pre-history, markers | 6 | 7 |
| pre-history, non-system, non-empty | **0** | **0** |
| post-history, system, non-empty | 8 | 9 |
| post-history, non-system, non-empty | 1 (assistant, 49 chars) | 0 |

So a request upstream frames as roughly 26 or 64 messages this host frames as
one system message plus the conversation. The **text** is the same and in the
same order; what differs is where the provider sees the boundaries, and
providers disagree about how they join multiple system messages.

A second, narrower gap sits in the same place: `resolvePreset` keeps `item.role`
for a post-history contribution and **drops it** for a pre-history one
(`chat-completion.ts`, the `placement: afterHistory ? … : { kind: 'system' }`
branch), so an enabled pre-history prompt authored as `user` or `assistant`
would be folded into the system block under the system role. Measured above:
**zero** enabled prompts in either preset sit in that position, and the one
non-system enabled prompt that exists is post-history, where the role is
honoured. Named because the code cannot express the case, not because anything
here hits it.

Both are left alone in this round. Changing the framing changes every recorded
prefix hash and every cache figure in §38 and `CACHE-TARGET.md`, and the
experiment that would justify it is provider-side — does DeepSeek treat one
40 KB system message differently from twenty-six smaller ones? — which nothing
here has run.

## 49. What the parity instruments are, and what they cannot answer

**Kind: instrument note.**

`scripts/capture-endpoint.mjs` is a loopback-only OpenAI-compatible endpoint that
writes every request body it receives to disk verbatim and answers a fixed
empty stream. Pointed at from SillyTavern's Custom source, it yields **ST's own
request** for whatever card, preset and conversation is open — the only artefact
that can settle a parity argument, because the request is the product of ~100
settings fields, two macro passes, a world-info scan, a token budget and three
regex tiers, and only the final body knows which of them diverged.

`@iris/preset`'s `parity.ts` compares two such bodies in four layers — body
fields, message framing, system blocks aligned by content, first byte of
divergence — and `scripts/preset-parity.mjs` is the shell that reads files,
optionally stands a headless host up for the Iris side, and prints.
`notes/packages/iris-preset/PARITY-HOWTO.md` is the operator's walk-through.

Three limits, stated because a report that looks complete is the dangerous kind:

1. **A report describes one assembly, not a standing fact.** World-info
   activation, `{{random}}`, MVU variables and depth placement all move with the
   conversation's state. A claim that a difference is *stable* needs two
   captures at different turns agreeing.
2. **Cache-friendly assembly must be off** (`IRIS_CACHE_FRIENDLY=0`) or its
   deliberate reordering (§38) buries every other finding under "moved". The
   script sets it when it assembles the Iris side itself and says so in the
   header; when both sides are captured, the operator has to.
3. **The block alignment is finer than a prompt boundary.** Blocks are cut on
   the blank line, so a prompt whose own text contains one splits into two —
   equally on both sides, which costs a reader nothing and never moves a byte
   across a boundary, but means "matched 26" is a count of blocks and not of
   preset prompts.

The "moved" column is the minimum set of blocks whose relocation explains the
order — the complement of a longest increasing subsequence — not "every block
that now sits after a block with a smaller index". The naive reading names the
wrong elements: for `a,b,c` against `c,a,b` it reports *a* and *b* as moved when
**c** is what moved. That is asserted by test rather than argued.

## 50. A world-info depth bucket is classified and placed entry by entry, so the entries that hold still reach the prefix without the bucket having to

§38 item 2 named this as the next step and declined it. Its reason was that "one
contribution per activated entry … changes the `cacheFriendly: false` assembly
too (N separate messages where there was one joined block), and that path must
stay byte-identical". The reason is sound and the conclusion was avoidable: the
split does not have to live in the contribution list.

**What changed.** A contribution may now carry `members` — the parts its text is
the join of — beside its text. The text stays authoritative. With cache-friendly
assembly **off** nothing reads the member list at all, so a depth bucket is one
message joined with one newline, exactly as before, byte for byte. With it on,
the classifier keeps a hash row per member and the assembler places each member
by that member's own verdict: settled ones become their own messages in the
stable prefix, volatile ones deeper than depth 0 join the volatile segment, and
whatever is left is re-joined with the same newline and stays in the bucket's
own slot under the bucket's own id.

### Why the bucket was the wrong unit

SillyTavern merges every world-info entry sharing a depth and a role into a
single injection (`world-info.js`, one
`setExtensionPrompt(CUSTOM_WI_DEPTH_ROLE(depth, role), joined, …)` per bucket)
and Iris reproduces that. The merge is also where this corpus's largest
remaining loss lived, and **not because the text moves**: the entries in one
bucket are individually stable while the *set* of them changes as keywords
match, so the bucket's own hash moves every turn and the whole block is judged
volatile. `CACHE-CENSUS.md` §4.5 measured three of 爱衣's entries
(8 223 + 4 020 + 7 114 = 19 357 B) byte-identical across an adjacent pair inside
a bucket that could never be promoted; §38 item 1 attributed 7.4 of the 11
points still missing from that conversation's ceiling to exactly this block.

So the fix is granularity, and the smallest granularity that is *upstream's own
unit* is the entry: world info activates, budgets and orders per entry, and only
the final registration is per bucket.

### Why the off path cannot notice

Three things, and the third is what makes it a property of the code rather than
a claim about it:

1. `splitOf` returns nothing unless `cacheFriendly` is on, so with the flag off
   every read of the member list is short-circuited — the request, the budget
   charge, the itemization and the prefix reading all take the branch they took
   before members existed.
2. The remainder that stays in a slot is **re-joined** with the same separator
   the builder joined with, so a bucket nothing was taken out of carries the
   contribution's own text back rather than a reconstruction of it.
3. `splitOf` refuses a member list that does not rejoin to the contribution's
   text. A template that rewrote the text after the members were taken, or a
   builder that changed its separator, produces an unsplit bucket — a turn of
   rent — rather than a request containing text nobody assembled.

The separator is written out on both sides (`prompt.ts`'s `joinEntries` and the
pipeline's `MEMBER_JOIN`) for the reason `SYSTEM_JOIN` and the squash separator
are: they are decided by two independent upstream lines, and one constant
standing for both would let a change to either silently change the other. What
keeps them honest is not the comment but `depth-bucket-entries.test.ts`'s "the
builder's join and the assembler's separator are the same string" — because a
mismatch here fails **silently**, as a bucket that is simply never split.

### Member identity

`<bucket id>#<book>.<uid>` — `worldInfo.depth.0.0#atlas.10`. The book is part of
it because uids collide constantly across a global book, a character book and a
chat book (`PreparedEntry`'s own note), and the bucket prefix is part of it
because one entry can sit in two buckets at different depths or roles. The id
has to survive its neighbours coming and going, or the classifier would compare
two different entries' hashes under one name; it does, because it names the
entry and nothing about the bucket's membership.

The label is the entry's own `comment`, which is what SillyTavern's editor
shows, falling back to the book and uid. Not decorative: this is routinely the
largest row in the itemization, and `#13` names nothing.

### What it was measured to buy

`scripts/cache-friendly-probe.mjs`, 爱衣, eight adjacent pairs, 2026-09-09, the
conversation at 49 messages. The "on, bucket-level" column is the same code with
the member list suppressed — a zero-command control rather than an earlier
reading, and it had to be: the operator's own 爱衣 gained an exchange **twice**
while this was being written, and the probe's window slides with the
conversation, so a before column taken an hour earlier describes different
pairs.

| pair (msgs) | off | on, bucket-level | on, per entry |
| --- | --- | --- | --- |
| 33 → 35 | 71.5% | 87.4% | **94.5%** |
| 35 → 37 | 73.8% | 89.3% | **96.2%** |
| 37 → 39 | 73.7% | 88.6% | **95.2%** |
| 39 → 41 | 75.2% | 89.7% | **96.1%** |
| 41 → 43 | 72.8% | 86.3% | **92.3%** |
| 43 → 45 | 76.0% | 88.9% | **94.7%** |
| 45 → 47 | 70.5% | 81.8% | **86.8%** |
| 47 → 49 | 79.7% | 90.5% | **95.4%** |
| mean | 74.2% | 87.8% | **93.9%** |

The same-state control — one conversation state assembled twice — is **100%,
byte-identical**, in all three columns. That is the reading that would catch a
layout that flips, which is worse than either layout (§38's own measurement: a
one-generation prediction took a control from 100% to 0.3%).

**The reading is reproducible and the mean is not stable across corpus growth.**
Both halves matter. The six pairs this window shares with the reading taken at
45 messages (33 → 35 … 43 → 45) came back **identical to the byte** — same
bodies, same prefixes, same percentages — so the instrument and the code are
steady. The mean is not: at 45 messages the same three columns read
73.7% / 88.8% / **95.5%**, and the drop to 93.9% is entirely the two pairs the
window gained. `45 → 47` is one exchange of 19 436 B of new prose — the largest
in the sample — and no assembly change can serve text that did not exist last
turn. Quoting a single mean as the figure for this change would therefore be
quoting the conversation's writing rhythm as much as the code; the per-pair
column is the reading.

The bucket on that conversation has five activated entries; four are promoted
and one is not. The one left behind is measured volatile — its text really does
change between turns — and it sits at depth 0, where there is nowhere later to
send it. `43 → 45`'s remaining loss is 7 026 B, of which 6 605 B is new text.
§38's arithmetic predicted 96.5% for this change on the pair it had; measured,
the eight pairs run 86.8% – 96.2%, **five of eight at or above 95%**, and the
gain over bucket-level classification is 5.0 – 7.1 points on every one of them.

**Ceilings, not acceptance.** `CACHE-TARGET.md` §2 rules that 达标 is the
provider's own `prompt_cache_hit_tokens / prompt_tokens` over ten consecutive
turns. The probe sends nothing, so these numbers can say "the assembly is not
what is stopping you" and cannot say the target is met.

### The instruments follow the entry

- **`PipelineMessage.parts`.** A slot that is the join of several members
  records them, and `slotsOf` opens it with those parts instead of one. The
  trace's `subdivide` already lays message-slot parts down with a single newline
  (the squash separator, which is the same string), so the byte ranges in
  `cache-trace/` name the entry and `prompt.divergence` aligns entries across
  two requests by their own ids. A promoted member's message carries a
  single-part list purely so the entry's *label* can travel — a promoted member
  is not in the system string, so the seams cannot name it.
- **The itemization keeps one row per bucket** — the bucket is one contribution
  however many entries went into it, and a panel that grew five rows would
  describe a preset the user did not configure. The row's `deferred` /
  `promoted` now mean **all of its members**, and a bucket whose members went
  different ways carries neither: no single mark is true of it, and one invented
  for it would tell a reader their whole world-info block moved. `members`
  beside it carries the per-entry answer.
  `notes/apps/iris-web/DEVIATIONS.md` §69 for what the panel does with it.
- **The probe counts members.** `movedIds` reads the marks off rows *and*
  members: a collector that read rows alone would have reported "moved forward:
  nothing" for precisely the case this change exists to produce.

### One fix carried in this change

The continue separator's provenance update in `iris-turn`'s driver was written
`if (slot.parts.length === 1) only.text = slot.message.text`. Correct for a
one-part slot, and for a two-part slot it left the recorded parts a separator
short of their slot — which the trace reports as unattributed. It now appends
the postfix to the **last** part, which is the part the postfix belongs to
whatever the count. Reachable before this change only through a squashed run
whose last message was assistant-role; reachable after it through an
assistant-role depth bucket the split left holding two entries.

### Two things found and not changed

1. **The author's-note bucket is not split.** `worldInfo.authorNote` joins
   `anTop` and `anBottom` the same way, but it is a **system** placement: it is
   folded into one string with its neighbours, and splitting it would move a
   seam `systemSegments` has already described to the trace. It is also small
   on this corpus. Named because the mechanism would transfer.
2. **Outlet buckets are not split either**, for the same reason plus a second
   one: an outlet's text is consumed by a prompt template through
   `{{outlet::key}}`, so its parts are not slots of the request at all.

### What would overturn it

A conversation whose depth bucket is split and whose ceiling *falls*. The shape
that would do it is a bucket whose entries are individually unstable while their
join is not — the mirror of this corpus — where splitting adds message
boundaries and buys nothing. The probe's three columns are the instrument: the
"on, bucket-level" column is reproducible at any time by suppressing the member
list, which is one branch in `splitOf`.

## 51. A card's own generation is billed, so it is now recorded — on the conversation's header, and inside every figure

Upstream records **nothing** about what a generation cost, for any generation:
`extra.token_count` is SillyTavern's own *estimate of the reply text*
(`getTokenCountAsync`), and nothing anywhere stores what the provider said it
charged. So this whole area is Iris's — §28 is the turn side. This entry is
about the population that was still missing from it.

**The defect.** `TavernHelper.generate` and `generateRaw` — `#sideGenerate` and
`#generateRaw` — call `#stream` with **no `entry`**, and `noteUsage`,
`notePromptFingerprint` and `noteRoute` all hang off `entry.pending.turn`. A
card's request was therefore billed by the provider and recorded nowhere: no
`iris_usage` entry, no fingerprint, no route, nothing on the usage page, and
nothing in the conversation's own running total.

**Why it is not a corner.** MVU fires one of these per turn for its variable
update (`MagVarUpdate`'s `invoke_extra_model.ts:511`). On a conversation running
that card the unrecorded population is the same size as the recorded one, so
every figure Iris printed about cost was roughly half the bill — and the half it
omitted was the half the user did not ask for and could not see.
`CACHE-TARGET.md` §4.5 was written around this gap and required every PR to
state that its numbers excluded it.

**Where the record goes: a top-level `iris_side_usage` array on the chat
header.** Not on a message, and the reason is positional rather than
philosophical. `iris_usage` is an array *parallel to `swipes`* (§28,
`USAGE_FIELD`), so an extra entry with no swipe behind it shifts every real
record after it — the residual that module already names as its worst case,
reached deliberately. And a card's generation has no floor to pick: it is a
request the conversation made between two turns, not a candidate for either. The
other three homes lose the record silently and are enumerated at
`SIDE_USAGE_FIELD` — a message's `extra` is replaced wholesale on every
SillyTavern swipe; `chat_metadata` is replaced wholesale by `commitChatMetadata`
and is reachable from a card as `script.saveMetadata`, so the cards being
measured are exactly the code that would delete the measurements; `header.iris`
is re-minted by `importFile`. Same location and same argument as §28's
compaction record, which is the precedent.

Each entry carries the buckets, the route (`model`, `provider`), the request's
moment, `source: 'script'`, the request fingerprint, and a `caller`.

**`caller` is the RPC method name, and there is no script id to be had.**
Checked against the contract rather than assumed: `script.generate` carries
`chatId`, `userInput`, `systemPrompt` and `maxHistory`; `script.generateRaw`
carries `chatId`, `prompt` and `systemPrompt`. Neither carries a script id or a
run id, and neither does upstream's `TavernHelper.generate` — so a card could
not send one if it wanted to. `script.setExtensionPrompt` *does* carry a
`runId`, which is the shape a future attribution would take; adding it here
means widening two request schemas and changing what a card must send, which is
a contract change rather than a bookkeeping one. The method name is worth
storing on its own regardless: it separates an assembled generation
(`script.generate`, which re-sends this conversation's whole prefix) from a bare
one (`script.generateRaw`, which sends only what the card handed it), and that
is the distinction a reader asking "why is this card expensive" is after.

**The array is append-only and unbounded**, unlike `cache-trace.ts`'s eight
rotating traces — a trace is evidence and this is a sum, and a total that drops
its oldest entries understates a bill, which is the failure this entry exists to
remove. Measured 2026-09-09: one record serialises to 151 bytes at its smallest,
252 for the shape a DeepSeek route writes, 332 at its largest. So on the largest
real conversation on this machine — 爱衣, 51 lines, 34 recorded generations,
header line 3 387 bytes — a card firing one per turn would take that header line
to about 12 KB, and a thousand turns would take it to ~250 KB. One file in the
same corpus already carries a *single message line* of 237 KB.
`tests/side-usage.test.ts` pins the upper per-record figure, because these
numbers are the argument and an argument resting on a number nothing checks
drifts.

**Counted inside every figure, and named.** `ChatView.usage` now covers both
populations — a card's request was billed to this conversation on this
conversation's route, so a total that excluded it would be a total of something
other than the bill — and `ChatView.scriptUsage` reports the share. Likewise
`usage.summary`: `UsageTotals.script` is the same buckets over the
script-sourced records, present on the whole range, on each (time, model) cell,
and on each conversation subtotal. It is **absent**, never zero-filled, when no
card generation was counted — the optional-bucket rule one level out, and what
keeps 「其中卡脚本 0 次」 off every profile that runs none. There is deliberately
no matching `turn` share: the turn figure is the enclosing one minus this, which
is a subtraction a reader can defend, where a stored pair that must sum to the
whole is two numbers that can disagree with it.

**`usage.summary`'s reply, measured** on the operator's own profile, 2026-09-09
(17 chat files, 4 of them carrying any usage record, 37 recorded generations):

| reading | turns | script share | reply bytes |
| --- | --- | --- | --- |
| whole profile, as on disk | 37 | absent | **1 915** |
| 爱衣 alone (51 lines, 300 KB) | 34 | absent | **1 252** |
| whole profile, one card generation per recorded turn | 74 | 37 | **2 734** (+819) |
| 爱衣, same injection | 68 | 34 | **1 863** (+611) |

The first two are the honest zero: no file on this machine carries the key yet,
so the reply is byte-identical to what it was before this change — the `script`
field is absent, not zero-filled, exactly as the absence rule requires.

The last two are the bound, and the growth in them is **not** the field: the
injected records are dated today while the real ones are undated, so most of
those 819 bytes are new (bucket, model) cells. Isolated by re-serialising the
same summary with `script` stripped: the field costs **626 bytes over the 6
places that carry a share — 104 bytes each** (the range's totals, each cell, and
each conversation row). 104 and not the ~22 a nested-buckets guess predicts,
because every optional bucket the share reports is a key of its own; the guess
was wrong by more than 4×, which is why this is measured rather than reasoned.
Either way it is a nested object per place and not a doubled cell count, so the
reply stays a page of rows.

**The source comes from the record's location, not from the stored field.** A
per-message array is by construction a candidate's and the header array is by
construction *not one* — so `readChatUsage` decides "turn or not a turn" from
where the record was found rather than from what it claims, and a file arriving
from elsewhere cannot move a card's spend into the turn column or the reverse.
The field is still *written*, so the file says what it holds to a reader that is
not this code. Records written before the field existed carry no `source` and
read as turns, which is what they are.

**Since §55 the header array holds two populations, so the second half of that
rule has moved.** The location still says "not a turn"; the stored field now
chooses between the side sources, because a location cannot distinguish two
things kept in the same place. §55 states the split and why a record with no
readable `source` defaults to `'script'` rather than to unknown.

**What was still not recorded when this entry landed, and now is.** The
compaction summarizer (`#summarize`) is also a generation the provider bills
that produces no candidate, and it passed neither an `entry` nor a trace — so it
was invisible on exactly the terms this entry fixed for cards. It was outside
this round's scope, and the note here said it would fit the same array under a
`host.compaction` caller. That is what §55 did, under `source: 'compaction'`
with a share of its own on every figure.

**Not fixed, and not ours: the random uuid header on MVU's extra-model
request.** The census reported it as a gemini-path defect; it is card code.
`MagVarUpdate`'s `invoke_extra_model.ts:44` builds a 35-character random block
(`_.times(4, () => uuidv4().slice(0, 8)).join('\n')`) and `:570` prepends it as
a `role: 'system'` prompt — gated on the card's own 随机头部 setting **and** on
the model name containing `gemini`. It arrives here as the card's `prompt`, so
Iris has nothing to delete: there is no gemini path in this repo and no
`randomUUID` anywhere in request composition. Upstream SillyTavern does add a
uuid, and it is a different mechanism that does not sit in the cached prefix —
`bodyParams['user'] = uuidv4()`
(`src/endpoints/backends/chat-completions.js:2212`), a body parameter on the
OpenAI source only, gated on the `openai.randomizeUserId` config, default false.
What Iris can now do about the card's block is *report* it, which is the
recording above: the request is stored with its `prefixHash`, so a card whose
own header defeats its own cache shows up as a `script.generate` record whose
prefix hash changes every time while the conversation's does not.

**What would overturn the storage choice.** A SillyTavern release whose swipe or
save path rewrites unknown top-level header keys. `formatChatFile` writes the
header verbatim and `parseChatFile` reads it verbatim, and `header.iris` has
lived there since the beginning on the same assumption, so the two would fail
together.

## 52. A reply the provider cuts short is a fault with a name and a record, not a free turn

**Kind: fix to how a closed-mid-stream reply is reported and recorded.**

Measured on 爱衣, 2026-09-09: after a profile was saved for the route `deepseek`
(`baseURL https://api.deepseek.com`, **no** `/v1`), cache traces `1..5.json` all
recorded `provider: 'deepseek'` with `inputTokens` and `cacheReadTokens` **missing**
while the report panel showed the single word `terminated`; trace `0.json`, sent
through the default route (`https://api.deepseek.com/v1`), carried usage. Five
adjacent traces read like five free turns, and the sixth (the default-route one)
was the only one that looked billed — a reader could not tell "the provider never
answered" from "the provider served it for nothing".

Two findings, kept apart because only one was a defect.

**Route parity is not the cause.** Both the host-default route and the saved
profile route reach the same `OpenAiCompatAdapter` class; there is no route-specific
URL, usage, or error-handling path to unify. And the `/v1` difference between the two
routes is a real configuration difference, not an assembly bug: OpenAI documents
`https://api.openai.com/v1` as its base, OpenRouter documents
`https://openrouter.ai/api/v1`, and DeepSeek documents `https://api.deepseek.com`
as its base_url while noting the appended `/v1` is unrelated to model version and is
also accepted. DeepSeek answers both spellings, so the two are **preserved**, not
collapsed: the join strips trailing slashes only
(`packages/iris-llm-openai-compat/src/index.ts`), so `/v1`, `/v1/` and `/v1///` all
reach the same `POST …/v1/chat/completions` and no `/v1` is ever invented for a base
that already sits at the right root. A spelling that reached a different path than the
user typed is pinned by `baseurl-parity.test.ts`.

**The defect is the unreadable transport error.** A provider that closes the
connection mid-reply surfaces in undici as the bare `TypeError: terminated`, which
escaped the adapter unwrapped and was broadcast verbatim. Because the usage chunk in
an OpenAI-compatible stream rides the **end** of the stream (after `[DONE]`), a peer
close means usage never arrived — so the absent figures on those traces were the
honest record, and zero-filling them would have read as free turns. The fix says both
things where a reader looks:

- the adapter turns the bare word into a sentence naming the failure and its cost
  (`connection to … was closed by the peer while the reply was streaming; no usage
  was reported for this turn`, code `TRANSPORT`);
- the service records that sentence as an `error` field on the trace of the turn it
  happened to, in the same `finally` that writes every other trace line, so the report
  and the record describe the same failure. A caller stop (`AbortError`) is excluded:
  a stop settles the partial reply as a note, not a fault, and records no `error`;
- `prompt.divergence` carries the interrupted turn's `error` to the comparison, and the
  excuse list names it `interrupted`, checked **before** cold-start/route/stale so a
  shortfall caused by a cut-short reply is never reported as the operator's defect.

`cache-trace.ts` stores the `error` only when the reply failed to complete; usage
fields stay absent rather than zero on such a trace. What would overturn it: a trace
whose `error` disagrees with the `stream.error` the panel showed for the same turn,
or an interrupted turn whose divergence is reported under any excuse but
`interrupted`.

## 53. The preset's own regex tier now runs — behind an allow-list of its own, off until asked

**Kind: compatibility feature landing, with one deliberate divergence in the
*storage* of the permission and none in its default. §47 is the measurement this
implements; read it first for the numbers.**

**Upstream.** `getRegexScripts` walks three tiers —
`SCRIPT_TYPES = { GLOBAL: 0, PRESET: 2, SCOPED: 1 }`, iterated by key insertion
order, so the run order is global, preset, character
(`extensions/regex/engine.js:11-16`, consumed at `:99`; §35 is the correction
that got that order right here **before** there was a preset tier to observe it
with). The preset tier reads
`presetManager.readPresetExtensionField({ path: 'regex_scripts' })` (`:126`) —
the active preset file's own `extensions.regex_scripts` — and
`getScriptsByType` refuses it unless
`extension_settings.preset_allowed_regex[getCurrentPresetAPI()]` contains the
preset's **name** (`:126-128`), with `getRegexedString` the one caller that asks
for `allowedOnly: true` (`:346`).

**Iris now carries all three.** `scriptsOf` (`regex.ts`) takes a fourth
argument, the active preset's tier, and pushes it between the global scripts and
the card's; `ChatEntry` holds it beside the other two and `ChatStore` reads it
through a closure exactly as it reads the global list and the per-card policy,
because *which preset is active is itself runtime state* — a value captured at
boot would keep the launch preset's rewrites running over prompts assembled from
a different preset entirely.

### The tier arrives off, and that is upstream's default rather than a divergence

`ScriptPolicyStore.presetRegex` answers `allowed: record?.regexAllowed === true`
— **absent means refused** — which is the mirror image of the per-card
`regexAllowed` in the same file (§30, where absent means allowed). The two
defaults disagree on purpose, and the reason is the subject rather than the
mechanism:

- a card is a document someone chose to play, and **11 of the 15** local cards
  that carry a regex tier use it to strip their own bookkeeping blocks out of
  the reader's page — refusing by default visibly corrupts the reading;
- a preset is a settings file people pass around by the dozen, and the one
  measured in §47 ships **40 rules, 18 live: 6 `promptOnly`** ones that rewrite
  **the outgoing request** and 12 `markdownOnly` prettifiers. §47's own
  sentence is the ruling: *"a user importing a preset silently gains 18 rewrite
  rules over their transcript"*, and no moment in an import is a moment anyone
  said yes.

So the permission is a decision the user makes in the preset panel, per preset,
and the panel says the same thing SillyTavern would: a preset runs its regex
once its name is on `preset_allowed_regex`.

### The allow-list is keyed by preset name, and kept out of the preset file

`script-policy.json` grows a second record beside `characters`:
`presets: Record<presetName, { regexAllowed?: boolean, regexEnabled?: Record<ruleId, boolean> }>`.

**Keyed by name** because that is what upstream's own list is keyed by, and
because a preset body has no other identity here — the library addresses presets
by name, a switch records a name, and a re-import under the same name is the
same preset to every other surface. It is also what makes a switch *carry the
permission with it*: allow 狐神抚, switch to 咩咩, switch back, and 狐神抚's
rules are running again without being asked for a second time.

**Kept out of the preset file** — the divergence, and it is §31's ruling applied
to a document that travels more freely than a card. Upstream stores its
allow-list in `extension_settings` too, so this is not a divergence from
upstream's *placement*; the divergence is that Iris also refuses to write the
**per-rule** switch back into the file, where upstream would
(`writeExtensionField`, `engine.js:148`). A permission written into a preset
would reach whoever the file was passed to next as a permission *they* appeared
to have granted, and a re-import would quietly revive a rule the user had
switched off. The cost, stated: a rule switched off here and then exported
carries the *preset author's* `disabled`, not the user's — the same cost §31
already names for cards.

`presets` is read **beside** `characters` rather than instead of it, because a
policy file written before this record existed carries `characters` alone and a
reader that required both would drop every decision the user had already made.

### An unnamed active preset cannot be allow-listed, and says so

The gate needs a name, and this host can be in a state upstream cannot
represent: assembling with the file its composition configured
(`config.presetPath`), which has no library name. Such a tier can never be
permitted, so `regex.presetList` answers `{ scripts: [], allowed: false,
malformed: 0 }` with **no** `presetName`, the two writes refuse by naming the way
out ("save it to the preset library first"), and the panel prints the sentence
instead of a switch that could not be honoured.

### One reading of "the active preset", for both the runner and the panel

Both the chat store's closure and the service's panel projection read the
**persisted** selection — `settings.json`'s `preset` section, through
`settings.presetName()` and `settings.presetBody()` — and not the live
`#activePreset` field the assembler holds. Every path that changes the active
preset writes through `settings.setPreset` before it returns (`#applyPreset`,
`#persistActivePreset`, `preset.save` over the active name, `preset.delete` of
it), which is what makes one reading serve both. Two readings would be two
places deciding what "the active preset" is, and the day they disagreed the
panel would show a reader a tier their conversations were not running.

The wiring itself is `presetRegexSource` in `regex.ts` rather than two lines at
the composition, so the test exercises the wiring the host uses instead of a
hand-copy of it.

### A preset switch reaches conversations that are already open

`#applyPreset` calls `#refreshRegex()` after persisting, and so do the two paths
that change only the *name* (`preset.save` over the active name, `preset.delete`
of it) — the name is what the allow-list is keyed by, so those writes can start
or stop a tier without touching a rule. `ChatStore.refreshRegex` re-reads all
three tiers and every open conversation is re-announced, which is upstream's
`reloadCurrentChat()` after its own panel writes. A manager mutation
(`preset.setEnabled`, `preset.move`, `preset.upsertPrompt`, …) deliberately does
**not** refresh: those edit `prompts` and `prompt_order` and cannot reach
`extensions.regex_scripts`, and a refresh per prompt toggle would re-announce
every open chat on every click.

### Two of the 40 rules are not rules, and the number is reported

`readPresetRegex` keeps a row only when `findRegex` and `replaceString` are
strings **and the pattern is not empty**, and returns how many it refused. The
empty pattern is not a harmless no-op that could be passed through: `new
RegExp('')` matches at every position, so running one of §47's two UI separators
would splice its `replaceString` between every character of every message
(`'abc'.replace(new RegExp('', 'g'), '!')` is `'!a!b!c!'`, pinned in the test).

The count travels on two channels, deliberately: `regex.presetList` carries
`malformed` so the panel can say it — the durable channel, since a preset with 38
listed rules and one with 40 of which 2 are unrunnable look identical otherwise —
and the composition logs it once per preset-and-count for whoever is reading a
transcript rather than a drawer. It is reported whether or not the tier is
allowed, because a file carrying unrunnable rows is a fact about the file, and
hearing it only after switching the tier on would be hearing it at the worst
moment.

### Where a user sees it

Settings drawer, a new section **「这份预设的正则」** between the global tier and
the card's — *its subject is the preset section above, but its place is where it
runs*, because the three regex sections are read as a sequence and a reader
comparing them is comparing along the axis that decides which rewrite wins. The
section lists the rules whether or not they run (upstream's own panel does, and
for this tier "refused" is the ordinary state rather than an edge case), reports
`M of N running` or `N rules, not enabled`, carries the tier permission and one
switch per rule, offers export, and badges the three states a row can be in: off
by the preset, unaddressable (no `id`), and on-but-waiting-on-the-tier.

### What would overturn the default

A preset observed using its tier the way cards use theirs — to hide its own
bookkeeping from the reader rather than to rewrite the request — measured over
more than one preset. §47's numbers are one preset's exposure (咩咩预设 ver 5.8.1
carries no `regex_scripts` at all), and the honest reading is that the default is
chosen on the *kind of document* rather than on a corpus statistic.

## 55. The compaction summarizer's own request is billed, so it is now recorded — beside a card's, under its own asker

**Kind: fix to a gap this file already named.** §51's own "what is still not
recorded" paragraph described it before it was fixed: `#summarize`
(`service.ts`) is a generation the provider bills that produces no candidate,
and it passed neither an `entry` nor a trace nor a `side`, so it was invisible
on exactly the terms §51 had just fixed for cards. A profile that had compacted
had a usage page short by one summary request per compaction, and nothing on the
page named the omission.

**Upstream records nothing about what any generation cost** — §51's first
paragraph has the citation — so as with the card half, this whole area is
Iris's. Upstream also has no compaction: the Summarize extension injects a
summary and keeps sending the full history, which is §27. There is therefore no
upstream behaviour to diverge from here; what this entry records is a *figure
Iris prints about itself* that was wrong by a knowable amount.

**Where the record goes: the same `iris_side_usage` array on the chat header,
under `source: 'compaction'` and `caller: 'host.compaction'`.** Same location,
same append-only rule, same three refusals §51 lists (not a message's
`iris_usage`, whose array is parallel to `swipes`; not `extra`, which
SillyTavern replaces on every swipe; not `chat_metadata`, which a card can
overwrite). One array now holds two populations, and that forced the one
behaviour change worth naming.

**`side-usage.ts`'s "the location is the authority" rule is now split, because a
location cannot distinguish two things stored in the same place.** The rule was
written when the array held one population and it was correct then. It now
reads: the **location** decides the record is not a turn — a `source: 'turn'` in
this array is still refused, so a file arriving from elsewhere cannot move a
card's spend into the turn column — and the **stored field** chooses between the
side sources. Anything that is not a side source reads as `'script'`, which is
not a guess but the population: `'compaction'` did not exist until this landed,
so every record already written under this key without one is a card's.
`sideSourceOf` is the one place that decides it, and `appendSideUsage`
normalises on the way in for the same reason it does on the way out.

The consequence for the reading half: `scriptUsage` used to add every record in
the array, because every record in the array was a card's. It now filters. A
version that kept summing everything reports a card share that includes the
host's compactions — a figure labelled "how much of this was the card" that a
card did not spend, and one that still adds up against the total, which is why
`side-usage.test.ts` gives the two populations different counts *and* different
buckets.

**Two shares on the wire, not one merged "not a turn" figure.**
`UsageTotals.compaction` sits beside `UsageTotals.script`, and `ChatView`
carries `compactionUsage` beside `scriptUsage`. Merging them was available and
smaller. It was refused because the two answer different questions: a card's
spend is the card author's doing, a compaction's is Iris's own policy, and a
reader who wants less of the second changes a threshold rather than a card.
Both shares are **inside** the enclosing figures — billed to the same account on
the same route — and each is absent rather than zero when its population is
empty, which is the rule the optional buckets follow.

**A trace as well, under `kind: 'compaction'`, `turn: -1`.** The card path needs
no reason for its trace beyond "it competes for the same cache"; this one has a
stronger one. A summary lands at the **front** of the next request's history, so
it is the one body that explains why every later turn's prefix changed — a
reader comparing two turns across a compaction has no other way to see it.
`turn: -1` because the request is billed and is not a turn: the automatic
trigger runs *before* the turn it protects, so "whichever turn was pending" is a
real turn here, and folding the host's summary onto it would file it against the
user's reply.

**No `entry` is passed, deliberately, and that is unchanged.** The prompt is the
host's, so a card's templates must not evaluate in it, its residual macros are
not a card's fault, and the estimator calibration and the turn's `actualTokens`
must not be moved by a request that is not the turn. The three parameters answer
three different questions and this generation answers them differently: no
`entry`, a `trace`, a `side`. The stale sentence in `#stream`'s own doc — which
claimed the summarizer "passes an entry and no trace target", true of neither
half — is corrected.

**The failure rule is inherited, not re-decided.** The bill is written in
`#stream`'s `finally`, so a summary that reported its usage and then failed is
still recorded (it was charged); a summary the provider refused before reporting
anything leaves **no** record rather than a zero-filled one, because an invented
`0` is a claim about a generation nobody measured. Both directions are pinned in
`compaction-usage.test.ts`.

**What would overturn it.** A SillyTavern release whose save path rewrites
unknown top-level header keys — the same thing that would overturn §51 and
`header.iris` together. Or a future side source that the `'script'` default
mislabels: the moment a third asker exists, records written *before* it must
still be distinguishable from it, and the only honest way to do that is what was
done here — the new asker writes its own name, and the default keeps naming the
population that predates it.

## 56. The reply reserve is the request's own `max_tokens`, not a host constant

**Upstream, exactly.** One figure does both jobs and it is `openai_max_tokens`:

| what | where |
| --- | --- |
| the assembly budget is `context − response` | `public/scripts/openai.js:3887` — `setTokenBudget(context, response) { this.tokenBudget = context - response }` |
| called with the two settings | `public/scripts/openai.js:1558` — `chatCompletion.setTokenBudget(userSettings.openai_max_context, userSettings.openai_max_tokens)` |
| and the same value goes on the wire | `public/scripts/openai.js:2750` — `'max_tokens': settings.openai_max_tokens` |
| even the advisory warning divides by it | `public/scripts/PromptManager.js:1677` — `const tokenBudget = this.serviceSettings.openai_max_context - this.serviceSettings.openai_max_tokens` |

There is no separate "reserve" concept upstream at all. `openai_max_tokens` is
subtracted from the window to get the prompt budget, and it is what the request
asks the model to write. Read 2026-09-09, SillyTavern 1.18.0.

**The defect.** Iris reserved `AppServiceOptions.reserveTokens` (default 1 024)
in every assembly and sent `settings.maxTokens` as `max_tokens`. On the
operator's own profile those are 1 024 and 65 535, so a prompt was allowed to
fill the window to within 1 024 tokens of the top and then told the provider it
might write 65 535 more. The overflow is arithmetic, not a risk assessment:
998 976 + 65 535 = 1 064 511 against a 1 000 000 window, 64 511 over. That is a
provider error at send time, where a dropped floor would have been a trim.
Reported by the #38 pass and left unfixed then; `:3571`'s
`response: settings.maxTokens ?? this.#options.reserveTokens` — the
`{{maxResponse}}` macro — shows that one site already knew the pair had to
agree.

**The fix, `service.ts`'s `#reserveFor`:** `settings.maxTokens ??
this.#options.reserveTokens`. Upstream's formula, with the host's constant kept
as the fallback for a chat that configures no `maxTokens` — because nothing to
subtract is not the same as subtracting nothing: a window with no reply
allowance held back is the one shape that cannot be sent, and a default install
stores no `maxTokens` at all. The resolved figure now reaches all the places
that were reading the constant: `#chatBudget` (so `ChatBudget.reserve`, which is
the capacity card's divisor), `#budget` (the assembly, on all four of its call
sites), `#itemizationOf` (the record and the preview), and `#contributions` (the
macro, which already agreed). `#budget`'s `window` and `reserve` are both
required parameters now, for the reason `#itemizationOf` already gives about
`window`: a defaulted budget figure is a wrong answer that assembles perfectly.

**Measured, on the operator's own 爱衣, through the product's own readers**
(`chat.open`'s `ChatBudget` and `prompt.itemize`'s preview, over a scratch copy
of the profile; nothing was sent). The control is the same conversation with the
stored `maxTokens` set to 1 024, so the only variable is the reserve:

| | before (reserve = 1 024) | after (reserve = 65 535) | no `maxTokens` stored |
| --- | --- | --- | --- |
| window, and its source | 1 000 000, `model` | 1 000 000, `model` | 1 000 000, `model` |
| reserve | 1 024 | **65 535** | 1 024 |
| available (`context − reserve`) | 998 976 | **934 465** | 998 976 |
| compaction threshold (0.8 ×) | 799 180 | **747 572** | 799 180 |
| retained tail (0.16 ×) | 159 836 | **149 514** | 159 836 |
| this conversation's next request | 22 546 tok | 22 546 tok | 22 546 tok |
| `droppedHistory` / `overBudget` | 0 / false | 0 / false | 0 / false |
| stable prefix | 15 527 tok | 15 527 tok | 15 527 tok |

The window is 1 000 000 and not the stored 2 000 000 because §44's clamp is in
force: this chat's own model override is `deepseek-v4.1-flash-expires-on-0910`
and the table answers 1M for the `deepseek-v4-(flash|pro)` family. The third
column is the fallback control, and it is the reading that a fix written as
"always send `maxTokens`" fails.

**The knock-on is real, and it is the correct direction.** `assemble` spends
`context − reserve − fixed` on history, and both §32's block trim and §33's 0.8
compaction threshold divide by the same difference (`compactionSpec`'s own doc
explains why it is deliberately the same denominator as the capacity meter's).
So a larger reserve makes the trimmer bite earlier and the compaction trigger
fire sooner — 6.5% sooner on this profile, threshold 799 180 → 747 572.
Upstream does exactly this, and it is what makes the trigger meaningful: a
compaction threshold sitting *above* the level at which the trimmer starts
silently dropping floors is a threshold that fires after the damage it exists to
prevent.

**On this conversation it changes nothing observable**, which is worth stating
rather than leaving implied: 22 546 tokens is 3.0% of the new threshold and 2.8%
of the old, so 爱衣 is 33× away from either. This is a correctness fix to the
arithmetic, not a behaviour change anyone on this profile sees today — the
profile where it *would* be seen is one whose requests already run near the
window, which is where the overflow was waiting.

**What would overturn it.** A SillyTavern release that stops subtracting
`openai_max_tokens` from `openai_max_context` — the four citations above would
have to move together — or a provider whose `max_tokens` is documented as a cap
on the reply *inside* the context window rather than in addition to the prompt,
for which the reserve would be zero and the whole subtraction wrong. The
fallback is pinned by `reserve-budget.test.ts`'s control, and the identity
between the reserve and the wire's `max_tokens` by its first test.

## 57. A connection test names a fault in the field, and says the reason under "could not reach"

**Kind: fix to how `connection.test` classifies a `fetch` that threw.**

Reported 2026-09-09: 「无法连接到端点。请检查地址与网络。」 from the connection form,
one millisecond after pressing test, with a DeepSeek key and endpoint that worked on
every other client the same afternoon. The host's own probe from the same process to
`https://api.deepseek.com/v1/models` answered 200 with three models in about one
second, so the network was not the fault. What was: `#probeEndpoint` caught every
non-`TimeoutError` throw from `fetch` and filed it under `network` — including the
two `TypeError`s `fetch` throws **before any packet leaves**: an address it cannot
parse as a URL (no scheme; a full-width `：` from an IME; a stray word in the
field), and a header value it cannot carry (a code unit above 0xFF, or a control
character — a key with a CJK character pasted into it). The message did carry the
`TypeError` text, but the web panel showed only the translated sentence for the
code, so the reason never reached anyone.

Upstream has no probe of this kind (its connection test is the first generation),
so there is nothing to diverge from; the divergence recorded is against this
host's own previous answer.

**What changed.**
- Two refusals before the wire, each its own code: `bad-url` when `isRequestableUrl`
  (the WHATWG parser, `http:`/`https:` only) rejects the address the request would
  use, and `bad-key` when `headerValueFault` finds a character a ByteString header
  cannot carry. `latencyMs` is 0 for both, and the endpoint sees no request (pinned).
  The address is judged **before** the key is resolved: adoption of a stored or host
  key compares origins, and on the live host a scheme-less `api.deepseek.com/v1` with
  the deepseek preset came back `missing-key` — true, but not the fault in front of
  the person (pinned: that input is `bad-url`, `keySource: 'none'`).
- The `bad-key` message names the **index and code point** of the offending
  character and nothing of the value around it, so it can be shown beside the
  credential's field (pinned: the message contains neither the key's body nor the
  character).
- A key with a trailing newline is **not** a `bad-key`: the platform trims header
  values, the request leaves, and the endpoint judges it (pinned by a test that
  asserts the request arrived).
- `fetchFailureReason` reads through undici's `TypeError: fetch failed` to the
  `.cause` chain, so a `network` message now ends in `ECONNREFUSED`, `ENOTFOUND`,
  `CERT_HAS_EXPIRED` and the like rather than in "fetch failed" (pinned on the
  refused loopback port).
- Protocol: `ConnectionTestErrorCode` gains `'bad-url' | 'bad-key'` with the reason
  in their docblocks. Web side in web §75.

**What would overturn it.** A probe that reaches the endpoint and still answers
`bad-url` or `bad-key`; a `bad-key` message that contains any character of the key
other than the index and code point; a `network` message on a refused port that
does not carry the socket code.

## 58. A profile's route generates with the key its probe was passed with

**Kind: fix — the connection test and the installed route resolved the credential differently.**

Reported 2026-09-09 from 8788: a DeepSeek profile (preset `deepseek`, base URL the
bare `https://api.deepseek.com`) probed green, then every generation answered
`https://api.deepseek.com/v1/chat/completions responded 401: Authentication Fails (governor)`.
Measured against the endpoint the same hour: DeepSeek says `(governor)` **only** for
a request with no `Authorization` header at all; a wrong key gets
`Your api key: **** is invalid`, an empty Bearer gets `auth header format should be`.
So the route sent no key. The host's own credential opened both `/models` and
`/chat/completions` for the public model and the `-expires-on-0910` id alike.

**Why.** `connection.test` resolves its key through `#probeCredential`: typed →
the named profile's stored key → the host's startup key **at the same origin** →
none, and reports the source. `connection.activate` (and the boot-time re-install
in `index.ts`) installed the route with the profile's own `apiKey`/`apiKeyHeader`
and nothing else. The form's key field, left blank on a same-origin profile,
reads 「由宿主环境提供，留空即使用它」 — a promise the probe kept and the route did
not. The profile was saved without a key, the probe passed with the host's, the
route generated with none.

**Now.** `routeCredential(profile, host)` in `connections.ts` is the one ladder for
a route: the profile's own key (`stored`), else the host's at the same origin
(`host`), else none — the same three rungs the probe climbs below "typed", gated by
the same `sameEndpointOrigin`, so the host's credential still never reaches another
origin (pinned). Both installers use it: `#installConnectionFor` at activation and
the `storedActive` restore at boot. The header travels with the key that won. The
report line now ends in `key: stored|host|none` (grade `note` — the activation was
served; the word `none` is the diagnosis), so a route about to generate bare is
visible in the log before the endpoint says so — never the key. The boot restore
logs a warning for the same case.

**Pinned.** Same-origin profile with no key → installed with the host key; a
profile with its own key → its own; a different origin → none; the pure ladder's
four outcomes including the empty stored string.

**Found but not changed.** The form still saves such a profile with `hasKey`
absent, so a later host started without the environment credential will generate
bare with the same 401; the panel's sentence covers the running host, not a
future one. Adopting into the file (`adoptHostKey`) remains the durable choice.

**What would overturn it.** A route installed with a key the probe of the same
profile would not have sent; a host key reaching an origin other than the
host's; a `none` install that does not warn.

## 59. A connection's `provider` is a reference to a runtime route, not a snapshot of values — so a deletion cleans the layers and a generation resolves the route

**Kind: divergence from upstream (pre-existing), plus two fixes to what the
divergence leaves behind.**

Reported 2026-09-09 from the operator's own profile. `settings.json` carried
`chats["爱衣-20260909-001924"] = { "provider": "deepseek" }` with
`global.provider = "default"`, and `connections.json` carried
`profiles: []` — an empty list. The timeline behind that pair: at 20:40 a
connection with `provider: deepseek` and `baseURL: https://api.deepseek.com`
was activated on host **A** (its own log line: `connection now generates through
route "deepseek" at https://api.deepseek.com`), the activation carried a
`chatId`, so `ConnectionStore.patchOf` wrote `provider: deepseek` into that
conversation's own layer; the connection was then deleted and the override
stayed. A second host process **B**, started from the same data directory and
never asked to activate anything, opened that conversation and generated:
`no adapter registered for provider "deepseek"`.

**Two layers, and only the first is about the deletion.**

1. `provider` in either settings layer is a **reference to a runtime adapter
   route** — `routeOf(profile)`, which is `conn/<id>` for a profile on the
   `default` provider and the provider's own name otherwise
   (§27, `connections.ts:552`). `connection.delete` cleaned nothing, so the
   reference outlived the profile.
2. The registry holding those routes is **per process** and is filled by exactly
   two things: `connection.activate` and the boot restore. Neither has to have
   happened in the process that reads the settings file, so a name that was true
   when host A wrote it is a name host B's registry has never heard of.

**Upstream is not exposed to either, because it stores values rather than a
reference.** A SillyTavern connection profile is a *snapshot*: applying it writes
the api, the model and the preset into `oai_settings`, and deleting the profile
leaves those values in the settings — nothing in the generation path dereferences
the profile's name, so a deleted profile cannot break a chat. Iris stores the
route instead, and that is what makes a runtime-installed adapter for a
user-supplied endpoint possible at all (a snapshot has nowhere to put "the
adapter that can see this endpoint and its key"). **The storage decision is not
being reversed here** — two nets are added under it.

**Net one: `connection.delete` clears the layers that named the deleted route.**
- The route is derived **before** the splice (nothing is left to derive it from
  after) and the layers are cleaned only when that route has lost its last
  owner: the composition's own route and a sibling profile of the same provider
  are both still served (`#routeStillServed`), and clearing a layer that names
  one of those would undo a choice the deletion never touched.
- A live install of *this* process is deliberately **not** counted as an owner.
  The adapter would answer this turn and be gone at the next start, so leaving
  the reference in place would defer the failure rather than remove it.
- **`provider` only.** `patchOf` writes `{ provider, model, ...sampling }`, and
  the other two are *values*: a model id and a temperature stay meaningful when
  the profile that supplied them is gone, which is exactly what upstream leaves
  behind. Clearing them would turn "the endpoint you chose is gone" into "your
  model choice is gone too". The global layer returns to the composition's
  configured route; a chat layer loses the key entirely, so the layer below
  shows through.
- The method answers with `cleared: { global, chats }` (protocol), and a
  retained `host` note says which layers changed and that the model stayed. Not
  pushed: the user is looking at the panel they just deleted from.

**Net two: `#stream` resolves the route before the request leaves.** One place,
not four — a turn, `script.generateRaw`, `script.generate` and the compaction
summarizer each compose `provider: settings.provider` from their own settings
read, and a check written per caller is a check the fifth caller will not have.
The substitution lands before the prompt fingerprint and `noteRoute`, so the
usage record names the route the provider was actually billed on. Four answers:
1. **The host's own route** — always served.
2. **A route this process installed** — `#installedRoutes`, written by
   `#installConnectionFor` and therefore by all three install paths.
3. **A saved profile resolves to it** — installed here and now, which is
   precisely host B's case: the profile was on disk the whole time. A matching
   profile with no endpoint of its own names a route some other plugin
   registered; not ours to install and not ours to judge, so it passes through
   as before.
4. **Nothing resolves to it** — the request goes out on the host's own route
   rather than failing, the layer that named it is cleared, and both halves are
   reported as one `fault` sentence naming the dead route, the route used
   instead, and the layer repaired. **Pushed** (`irreversible`), because the
   value that layer held is gone and nothing else in the interface will say so:
   the panel reads settings when it is opened, so a mid-turn repair is otherwise
   invisible until something refetches. A fall back that changed **no** setting
   — a profile that exists on a host composed with no installer — is retained
   and not pushed, and leaves the setting alone: the connection is not the thing
   that is missing.

**Two deliberate departures from the task as written.**
- The host's own route is read as `hostConnection?.provider ??
  settings.configuredRoute()`, **not** as `#hostConnection().provider`. With no
  connection handed in by the composition — and the shipped composition hands
  none — that reader answers from the *global settings layer*, which is one of
  the two places a dangling name sits: the guard would have compared the
  dangling name with itself, passed, and sent the request to a route with no
  adapter. The configured default cannot dangle; it is the `llm-openai-compat`
  row's own registration. A test whose only difference is this reading holds it.
- The boot restore moved out of `index.ts` into
  `IrisAppService.restoreActiveConnection()`, called after construction and
  before any handler is registered. Not tidying: the inline version called the
  installer directly, so the restored route was invisible to `#installedRoutes`
  and the first generation of every restart would have installed it a second
  time.

**Postscript, 2026-09-09 (§60).** The first departure above describes
`#hostConnection()` as answering from the global settings layer. It no longer
does: §60 gives the service a launch snapshot and both readers take the provider
from it, so the two readings agree by construction rather than by which one a
guard reached for. The ordering rule survives unchanged, and is now the reason
the snapshot exists — the launch configuration is the only reading of "the
host's own route" that cannot dangle.

**What would overturn it.** A generation that reaches `ctx.llm.stream` with a
route no registration has answered for; a deletion that leaves a `provider`
naming the deleted profile's route in any layer, or that removes a `model` or a
sampling field; a fall back that repairs a setting without a report, or reports
without repairing; a route this process installed being installed again by the
next turn.

## 60. The host's own connection is a launch snapshot, and there is a way back to it

**Kind: fix to an Iris-only surface** — upstream has no "the connection this
process was started with" row at all (§27). Closes the open gap web §77 recorded
as its first cost.

**What was wrong, in two parts that only bite together.**

1. **`#hostConnection()` read `provider` and `model` from the global settings
   layer.** Its docblock said the row "describes the route the host actually
   generates through rather than a second copy of the same configuration" — true
   of a host that has never applied a profile, false from the first
   `connection.activate` onwards, because `ConnectionStore.patchOf` writes
   `{ provider, model, ...sampling }` into exactly that layer. So the panel's
   fixed first row, labelled 「宿主环境」 and documented as the launch
   configuration, quietly began describing the profile in force instead. The
   endpoint and the key state beside them come from the environment and stayed
   right, which is what made the wrong half hard to see: the row read
   `deepseek · deepseek-chat · https://api.deepseek.com` and every part of it
   was true of *something* — two of the connection, two of the launch.
2. **`ConnectionStore` had `markActive(id)` and no clearing path.** `activeId`
   could be moved from one profile to another, or dropped as a side effect of
   deleting the profile it named, and that was all. "No profile is applied" was
   reachable only by deleting something.

Together they made 「使用」 on the host row impossible to implement honestly: a
button reading that row's own `provider` and `model` back into the settings
would have re-applied the profile in force under the host's name, and nothing
could have put `activeId` back to absent afterwards.

**The snapshot.** `IrisAppService` takes `#launch = { provider, model }` in its
constructor: `hostConnection?.provider ?? settings.configuredRoute()` — the
reading §59 established for `#hostRoute()`, which now returns it — and
`hostConnection?.model ?? settings.configuredModel()`, a new accessor beside the
existing one and for the same reason: the store's constructed defaults are the
composition's decision, while the layer is where activations write. On the
shipped composition both come from `apps/iris/cordis.yml`'s `app` row, so the
model is `IRIS_MODEL`. Nothing short of a restart can move either.

**Three readers of `#hostConnection()`, one behaviour change.** Named because
"who benefits" is the question a change to a shared reader has to answer, and
two of the three read fields the snapshot does not touch:

- `connection.list` / `connection.save`'s `host` row (`#hostDefaultRow` →
  `hostDefaultView`) — **changed, and this is the point**: the row keeps
  describing the launch configuration after any activation.
- `connection.test`'s host branch (`#probeCredential`) — **unchanged**: it reads
  `baseURL`, `apiKey` and `apiKeyHeader`, none of which the settings layer ever
  held. A bare probe of the host's endpoint still adopts the startup credential
  at the same origin.
- `routeCredential`'s host argument (`#installConnectionFor`) — **unchanged**,
  the same three fields, so §58's ladder is untouched. `#recordHostModels`
  compares origins and is unaffected for the same reason.

**The way back: `connection.deactivate`.** No parameters, global only — the same
rule as `connection.activate` from the browser (web §77). It clears `activeId`
through the new `ConnectionStore.clearActive()` and writes the launch route
**and the launch model** into the global layer.

- **Why the model too, when §59 insists a deletion keeps it.** §59's rule is for
  a *deletion*: clear the reference, keep the values, because a model id
  outlives the profile that supplied it and losing it is a second loss nobody
  asked for. This is not a deletion. It is the same act as the activation one
  handler up — a person choosing which connection generates — and the
  connection they chose is the launch configuration, whose model is as much a
  part of it as its route. Writing the route alone would answer
  「使用宿主环境」 with a route from the environment and a model left behind by a
  connection the list now says is not in use.
- **Sampling is untouched**, which is §59's rule doing its job where it does
  apply: a launch configuration carries no temperature, so anything written
  there would be invented.
- `provider` is *written* rather than cleared (`{ provider: null }`, which
  `SettingsStore.set` restores to `configuredRoute()`), because the snapshot is
  the wider answer: a composition that hands a `hostConnection` in has a route
  the settings defaults never saw, and a clear would leave the layer naming a
  route `#hostRoute()` does not — which `#resolveRoute` would then repair on the
  next turn, reporting a fault for a setting this handler had just written.
- **No conflict with §59's ladder**, and it is pinned: after a deactivation the
  global `provider` *is* `#hostRoute()`, so the first rung passes, the
  generation goes out on that route, and nothing is reported or repaired.
- The adapter the last activation installed is left registered. Nothing names
  it, `installConnection` offers no un-install, and an unreferenced route costs
  one map entry until the process ends.
- The answer is `{ settings, activeId?: undefined, host }`, shaped so the
  browser writes the same three assignments it writes after `connection.activate`
  and `connection.list`. `activeId` is **absent**, not present-and-undefined.
- A retained `host` note says the layer went back to the launch route and model
  and that the sampling was left as it stands. Not pushed: the person is looking
  at the panel they pressed it in.
- `clearActive()` writes only when something changes — pressing 使用 on the row
  that is already current must not touch a user's file to record nothing.

**Pinned.** `connections.test.ts`: the host row still reads `default` /
`local-model` after a profile with its own provider and model is activated, with
the endpoint and key state asserted as still coming from the environment so the
test says which two fields moved; a deactivation puts route and model back,
keeps `temperature: 0.7`, answers with no `activeId` key at all, and clears the
id in the file on disk; `clearActive()` on a store with nothing active creates
no file. `route-resolution.test.ts`: a generation after a deactivation takes the
ladder's first rung, reports nothing and pushes nothing.

**What would overturn it.** A composition that hands a `hostConnection` in whose
provider or model can change while the process runs — the snapshot would then be
a stale copy rather than a launch record, and the field should become a reader
of that object; a report that the 「宿主环境」 row ought to describe what is
generating rather than what the host was launched with, which is the opposite
reading of one row and would make the old sentence 「在没有选中任何供应商时，回复由
它生成」 the truer one; a deactivation being asked to restore sampling, which
would mean launch configurations have grown some.
