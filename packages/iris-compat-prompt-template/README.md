# `@iris/compat-prompt-template`

> 状态：现状文档。描述 `main` `e356771` 的现状，核对于 2026-09-16。

EJS prompt templates, compatible with the **ST-Prompt-Template** extension the
user has installed and enabled.

A different thing from `@iris/macro`'s `{{…}}`. Macros substitute text; this
evaluates programs.

**Off unless asked for.** The composition ships `templates: false`; `IRIS_TEMPLATES=1`
turns it on. Containment is not a reason to opt someone in.

## Why it exists

Measured 2026-09-01 over the 19 cards in the local library. These are numbers
from that corpus on that date, not properties of the format:

| | |
|---|---|
| Cards using EJS | **8 / 19** |
| Template tags | **3364** |
| Where | `character_book.entries[].content` (3360), one `regex_scripts[].replaceString` (4) |
| In the world books beside them | a further **6575** tags across 8 of 18 books |

Zero in `description`, `first_mes`, `personality`, `scenario`, `mes_example`,
`system_prompt`, `post_history_instructions`, greetings, or entry keys.

The templates are not interpolation. Inside the tags: `if` 1749, `else` 833,
`var` 945, `const` 396, `function` 205, `return` 251, `try`/`catch` 139, `for`
118, `await` 63, `delete` 27. 87% of tags are the whitespace-slurping `<%_ … _%>`
form, because cards wrap prose in conditionals and slurping is what keeps the
conditionals free.

## The decision this package is

Evaluating one of these is running the card author's code, so the only question
that matters is where that happens. Upstream's answer is "in the SillyTavern
page, with the application in scope". This package's answer:

```
host process                          child process (one at a time, per batch)
─────────────────────────────         ──────────────────────────────────────
assembles the batch                   env: {}                 ← no credentials
refuses an item over 2^20 chars       --permission            ← no fs write, no spawn
pushes a JSON snapshot        ──►     --max-old-space-size=128
                                      fs read: this package + ejs + lodash
receives streamed results     ◄──     ┌──────────────────────────────────┐
applies the change set                │ vm realm: no process, no require │
through its own entry points          │ no working dynamic import        │
                                      │ nothing of the child's own realm │
                                      │ lodash, and the six env members  │
                                      └──────────────────────────────────┘
```

Only JSON crosses the process boundary. The child never holds a host object, and
every write it performs comes back *described* — so a template cannot bypass a
check the host makes on the way in.

**Nothing of the child's own realm crosses the realm boundary either**, which is
a separate claim and was false until 2026-09-11. Every callable a template can
see is a frozen trampoline built inside the `vm` context; every value it receives
is re-created there through the context's own `JSON.parse`, errors and promises
included; lodash is evaluated in the context rather than handed across; and the
variable state is built there once per batch, which is what keeps `getvar`'s
reference live the way upstream's is. The reason it matters: `escapeFn.constructor`
— EJS names that function in every template's scope — used to be the child main
realm's `Function`, and `Function("return process")()` from there reaches
`process`, `globalThis.fetch` and the IPC channel. `src/realm.ts` is the
mechanism; `tests/realm.test.ts` prosecutes it member by member, with a
deliberately unbridged function as the control that proves the probes can see an
escape at all.

Layers, because each covers the others' gap. Node's `--permission` does not gate
the network (there is no `--allow-net`), and deleting globals does not stop
`await import("node:net")` because `import()` is syntax, not a global — the realm
refuses that by design. Conversely, a realm escape is a known class of bug and
never a boundary alone, so `--permission` and an empty environment decide what an
escape is worth. The heap ceiling, the single child and the item cap decide what
a template that merely misbehaves can cost. Each of those four is an exported
constant rather than a number in this file — `CHILD_MAX_OLD_SPACE_MB` (128),
`CHILD_CONCURRENCY_LIMIT` (1, so batches serialise), `MAX_TEMPLATE_CHARS`
(1,048,576 **characters**) and `DEFAULT_DEADLINE_MS` (2000) — and
`childConcurrency()` reports the in-flight and peak counts, so "one at a time"
is observable rather than asserted.

[`notes/packages/iris-compat-prompt-template/DEVIATIONS.md`](../../notes/packages/iris-compat-prompt-template/DEVIATIONS.md)
lists every deliberate difference from upstream (§1–§12), what each was measured
to cost, and the residual risk that is *not* zero.

## Using it

```ts
import { evaluateBatch } from '@iris/compat-prompt-template'

const outcome = await evaluateBatch({
  items: [{ id: minted(), text: entry.content, origin: `worldinfo/${book}/${uid}`, locals: { world_info: entry } }],
  snapshot: { variables, chatMetadata, worldInfo, lorebooks, scalars, traceId },
})

for (const { id, result } of outcome.results) {
  // A failure is a value, not an exception: upstream keeps the original text and
  // carries on, so one broken entry never costs a generation. Keep the original
  // text for `result.ok === false` and report `result.error` rather than raising.
  if (result.ok) use(id, result.text)
}
```

**`outcome.ops` is a description of writes, not writes.** This package performs
none of them: the caller applies each op **through its own entry points**, which
is what keeps a template from bypassing a check the host makes on the way in.
`@iris/app-service` is the only caller today — `templates.ts` returns
`outcome.ops` up to `service.ts`, which applies them with its own `applyOps`
against the chat entry and turn. There is no `applyChangeSet` export, and there
should not be one; a helper that wrote for you would put the writes back inside
this boundary.

Item order is the contract: a `setvar` in item 3 is visible to item 4, and
`outcome.ops` is in the order the templates performed the writes.

`snapshot.lorebooks` is not optional and not a convenience. Upstream resolves
**exactly one** book through a fallback chain (`character` → `persona` → `chat`)
and scans only that; without the field the evaluator would have to guess, and
guessing "search everything" returns a same-titled entry from the wrong book
with nothing raised anywhere.

## Two things that will bite

**Order.** The pipeline is `substituteParams` (macros) → regex → EJS, and both
halves are load-bearing. A corpus card writes
`<%_ if ({{roll 1d100}} >= 100) { _%>` — an ST macro generating the JavaScript
source — and another has a `USER_INPUT` regex whose replacement emits a whole
`<%= getvar(…) %>` tag for this engine to evaluate. Text reaches `items[].text`
with both already applied.

**Timeouts are the host's job.** `vm`'s own `timeout` option bounds only
synchronous execution, and every one of the corpus's 63 `await`s walks straight
past it. The deadline is enforced by killing the process; results already
streamed are kept.
