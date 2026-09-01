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
