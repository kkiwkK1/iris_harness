# Accepting the chat-level MVU path with one real generation

One generation costs a real API call, so the run has to be able to *fail*. That
means choosing a message whose correct outcome is predictable in advance — not
merely one that makes something change, because "something changed" is also what
a broken fold looks like when the model happens to restate the current state.

## What is already known, before spending the call

The fold has fired on this card before. Replaying the existing 爱衣 chat's
per-turn tables through the product's own reader:

```
turn 1: baseline, 20 leaves
turn 2: 0 leaves changed
turn 3: 2 leaves changed   (a time-of-day string, and one numeric meter)
turn 4: 3 leaves changed   (the same time-of-day string, and two numeric meters)
```

So `recordVariables` → `applyCommands` → per-candidate storage is not an
untested path; turns 3 and 4 are model-produced commands that landed. **What the
single generation is accepting is the chat-level init path in front of it** —
that the tree the card declares is the baseline the commands fold onto, and that
the result reaches the frame.

## The message to send

Send, in the 爱衣 chat on the dev profile:

> 我先去睡了,明天早上再说。

Chosen for three reasons, none of them narrative:

1. **It targets the leaves that actually move.** `世界.当前时间` moved on every
   turn that moved anything; `世界.星期` is the only other leaf in that node.
   Both are plain scheduling state, so the acceptance does not have to read or
   quote anything else the card tracks.
2. **Its correct outcome is predictable.** Time must advance to a morning, and
   the weekday must advance by one. A fold that silently kept the old tree fails
   this; a fold that applied a command produces a value you can name in advance.
3. **It needs no fiction from the model to justify an update.** Cards that gate
   updates on "something happened" will emit a block for a time skip.

## The values to predict, written down before the call

Read off the newest table (turn 4) immediately before generating:

```
世界.当前时间 = "7月1日 23:00"
世界.星期     = "星期一"
```

The prediction, recorded in advance rather than fitted afterwards: the time
advances to **a morning of 7月2日** — the date carries, it does not merely
become some other clock reading — and the weekday becomes **星期二**.

If **neither** moves, the run has failed and the report table below says which
half. If only **one** of the two moves, the run has *not* failed: that is a
model that sent one command rather than two, the reports will be empty, and it
is a different result from a fold that did not work.

## Where the evidence is

Three independent readpoints. Take all three: any one of them can be right for
the wrong reason.

| Readpoint | What to look at |
| --- | --- |
| The stored tree | `chat[N].variables[swipe].stat_data`, at the new reply's `N`. **On the wire this member is JSON text, not a tree** — the transport stringifies it, so the frame must `JSON.parse` before indexing. |
| The event | MVU's `mag_variable_update_ended` (`VARIABLE_UPDATE_ENDED`), which fires per fold. Its absence with a changed tree means the compat layer, not the fold. |
| The debug page | Reports of kind `mvu`, pulled through `debug.reports`. On a clean turn there are none — see the table below for what each line means. |

### `message_id` is a turn, not a row index

This chat holds **9 messages and 5 turns**. Assistant rows 0, 2, 4, 6, 8 carry
turns 0 to 4; the user rows between them have no turn of their own and read
their reply's table.

Asking the host for `message_id` 5 through 8 therefore returns
`turn N has no generated reply to attach variables to` — **four refusals that
are entirely correct**, and that look exactly like four turns whose fold never
ran. Read from the frame as `chat[N]` and the transport maps the row index for
you; ask the host directly and the number must be a turn. After this
generation the new reply is row 10 and **turn 5**, and turn 5 is what to ask.

## If nothing changed: which half is broken

The whole point of the `mvu` report channel is that this question has an answer
rather than a guess. Read the reports for the turn:

| What you see | What it means |
| --- | --- |
| **No `mvu` report at all**, tree unchanged | The model wrote no update command. Both dialects now report a block they could not read, so silence here is positive evidence about the *model*, not about us. |
| `a reply started N _.verb() call(s) and M could not be read` | It asked, and the legacy reader could not parse M of them. Ours. |
| `a reply carried N <JSONPatch> operation(s) that produced no commands` | It asked in the other dialect and nothing understood it. Ours. |
| `path "X" does not exist` | It asked, we read it, and MVU refused because the path is not in the baseline. **This is the init path, which is exactly what this acceptance is testing** — the card's declared tree did not reach the fold. |
| Any other `MVU:` line | An `applyCommands` failure, named in the line. |
| The assistant row is there but **its turn has no table at all** (the host refuses it) | A third state, and neither of the two this acceptance was built to separate: `recordVariables` was never called, so the turn did not go through `#settle`. Check `stream.end` before reading anything else. |
| Tree unchanged, no reports, and `stream.end` carried `aborted` | The turn never settled; nothing folded because nothing finished. |

That first row is worth stating plainly, because it is the row the run is most
likely to land on and the one that used to be unreadable: **silence now
distinguishes "the model did not ask" from "we could not hear it"** — until this
was written, the legacy dialect produced the same silence for both.

## What the accepted run actually exercised

The reply wrapped **RFC 6902 patch operations inside `<UpdateVariable>`** —
nine `op: "replace"` entries in a `<JSONPatch>` block, with the model’s prose
reasoning above it and not one `_.verb()` call. Replaying the scan and fold
from the host’s own `baselineFor` reproduces the stored table byte for byte,
which is what attributes the write to `recordVariables`. The script’s own
`updateVariablesWith` cannot be excluded from the stored artifact — it would
no-op against an already-equal table — but the host path alone accounts for the
result.

**One credit withdrawn.** It was tempting to record this as the `<json_?patch>`
spelling fix paying off. `git log -p` says otherwise: the previous regex was
`/<JSONPatch>([\s\S]*?)<\/JSONPatch>/gi`, already case-insensitive, so this
camel-case block would have been read before that commit too. What the fix
added was the underscore spelling and code-fence tolerance — neither of which
this run touched. A passing acceptance is the easiest place to award a fix
credit it did not earn.
