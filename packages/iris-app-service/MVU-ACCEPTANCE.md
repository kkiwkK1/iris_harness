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

## Where the evidence is

Three independent readpoints. Take all three: any one of them can be right for
the wrong reason.

| Readpoint | What to look at |
| --- | --- |
| The stored tree | `chat[N].variables[swipe].stat_data`, at the new reply's `N`. **On the wire this member is JSON text, not a tree** — the transport stringifies it, so the frame must `JSON.parse` before indexing. |
| The event | MVU's `mag_variable_update_ended` (`VARIABLE_UPDATE_ENDED`), which fires per fold. Its absence with a changed tree means the compat layer, not the fold. |
| The debug page | Reports of kind `mvu`, pulled through `debug.reports`. On a clean turn there are none — see the table below for what each line means. |

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
| Tree unchanged, no reports, and `stream.end` carried `aborted` | The turn never settled; nothing folded because nothing finished. |

That first row is worth stating plainly, because it is the row the run is most
likely to land on and the one that used to be unreadable: **silence now
distinguishes "the model did not ask" from "we could not hear it"** — until this
was written, the legacy dialect produced the same silence for both.
