# Deviations from SillyTavern

Where the variable system deliberately does something other than what
SillyTavern does, and what each difference was measured to cost. A deviation
with no measurement is a guess, so every entry names the upstream source it read
and the corpus test that would overturn it.

Upstream source cited here is the **installed** copy,
`E:/sillyTavern/SillyTavern/`, read-only.

---

## 1. Three key names are refused at every variable write face, which upstream refuses nowhere

**Date.** 2026-09-11.

**Upstream.** SillyTavern's variables are `chat_metadata.variables`, a plain
object, and every write is a direct assignment with no filtering of any kind:

| what | where |
| --- | --- |
| the table is created as a plain object | `public/scripts/variables.js:22-24` — `if (!chat_metadata.variables) { chat_metadata.variables = {}; }` |
| an ordinary write | `public/scripts/variables.js:77` — `chat_metadata.variables[name] = value;` |
| an indexed write | `public/scripts/variables.js:63`, `:66`, `:72` — `localVariable[args.index] = …` then `chat_metadata.variables[name] = JSON.stringify(localVariable)` |
| a read | `public/scripts/variables.js:27` — `chat_metadata?.variables[args.key ?? name]` |
| a delete | `public/scripts/variables.js:598` — `delete chat_metadata.variables[name];` |

So in SillyTavern `/setvar key=__proto__ …` writes through the accessor and
re-points the table's prototype, and `getLocalVariable('constructor')` answers
a function nobody stored. **A correction to the audit's premise while we are
here:** upstream's own variable writer uses direct assignment only — there is no
`_.set` in `public/scripts/variables.js`. The lodash path writers are the
*extensions* (Tavern Helper's `function/variables.ts`, MVU's `_.set(…)`
command dialect), which is the same surface Iris reimplements, and it is those
that make a dotted path reach several levels down.

**Iris.** `src/keys.ts` exports one predicate — `isForbiddenKey`, over
`__proto__`, `constructor`, `prototype` — a path splitter
(`pathSegments` / `forbiddenSegmentIn`) and a deep own-key walker
(`findForbiddenKey`, arrays included), and every write face refuses through it,
in the error vocabulary that face already speaks:

| face | where | vocabulary |
| --- | --- | --- |
| the merge the audit named (`mergeWith`) | `packages/iris-variables/src/semantics.ts` — `insertOrAssign`, `insertMissing` | `ForbiddenKeyError` |
| the deletion (`_.has` walks the prototype chain) | `packages/iris-variables/src/semantics.ts` — `deletePath` | `ForbiddenKeyError` |
| the one write that performs no merge | `packages/iris-variables/src/store.ts` — `replaceVariables` | `ForbiddenKeyError` |
| `script.setVariables`, and everything else that stores a card's tree | `packages/iris-app-service/src/context.ts` — `assertStorable` | `invalid-request` |
| the `delete` leg of `script.setVariables` | `packages/iris-app-service/src/service.ts` | `invalid-request` |
| the template's ops on the way back in | `packages/iris-app-service/src/template.ts` — `applyOps`, `writePath` | `invalid-request` |
| the template's `setvar`, *inside the realm* | `packages/iris-compat-prompt-template/src/environment.ts` | `ForbiddenTemplateKeyError` |
| MVU commands (`_.set('a.__proto__.b', …)`) | `packages/iris-mvu/src/apply.ts` | a per-command rejection, batch continues |
| an `[InitVar]` world-book body | `packages/iris-mvu/src/initvar.ts` | reported as an entry failure, book continues |

Leaf own keys and path segments are refused alike, all three names.

**Why.** `mergeWith` walks the incoming tree key by key and `JSON.parse` hands
back `"__proto__"` as an ordinary own property, so a card's variables table is a
direct route into `Object.prototype`. Safety rested entirely on `lodash-es`
resolving to 4.18.x, whose `safeGet` refuses two of the three inside
`baseMerge`, while the range in `package.json` said `^4.17.21` — a promise about
a file on disk rather than a property of this code. The difference from upstream
that makes it worth diverging: SillyTavern's tables live in the page that is
already running the card's script, so a pollution there costs the attacker
nothing he did not already have. Iris's cross a wire into a **host process**
that serves every other conversation.

**The measurement, and what it decided.** The audit allowed for a narrower rule
— refuse `constructor` and `prototype` only as *path segments*, keep them as
leaf data — if any real card stored one. Measured over the corpus (13,838 JSON
documents, 765,759 objects and arrays walked, 3,518 deduplicated script and
interface-text bodies at 13.8 M characters, 2,855 variable-API call sites):

| shape | count |
| --- | --- |
| own data key named `__proto__` / `constructor` / `prototype` in any card, world book, chat, group, preset or settings file | **0** |
| variable path containing one as a segment | **0** of 2,855 call sites |
| `constructor` in card code | 18, every one a class `constructor(…) {` definition |
| `prototype` in card code | 3, every one `Object.prototype.hasOwnProperty.call(…)` |
| `__proto__` anywhere, in data or in code | **0** |

Both columns were counted — `extractScripts` bodies *and* interface text
(`regex_scripts[].replaceString`, rendered `<script>` blocks, preset prompts,
disk world-book entries) — because a card carries code in both. So the narrow
rule would have bought nothing and cost a second rule to remember, and all
three are refused in both positions.

**What would overturn it.** A card that stores a **map keyed by arbitrary
strings** in its variables — a token table, a frequency count, a user-named
inventory — would eventually produce `constructor` as honest data. One such
object already sits on this disk: `data/_cache/deepseek.json` at
`$.model.vocab.constructor` (value `81746`), a BPE vocabulary ST downloaded. It
is not a variable table and does not pass through any face listed above, but it
is the shape that reopens this. The change then is to narrow `isForbiddenKey`'s
own-key half to `__proto__` and keep the path half wide; `findForbiddenKey` and
`forbiddenSegmentIn` are already separate functions so that this is one edit.

**Held by** `packages/iris-variables/tests/keys.test.ts` (the predicate, the
splitter, the walker over nested objects and arrays, and the property test that
fuzzes every forbidden shape through every face and then asserts
`Object.prototype`, `Array.prototype` and a fresh `{}` are untouched), and by
each face's own suite. The frozen-prototype assertion is the one that matters:
a walker that missed a shape would let the fuzz through and the property test
goes red without needing to know which face let it in.
