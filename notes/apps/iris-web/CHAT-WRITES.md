# Cards that write to `getContext().chat` — design

Status: **for review.** One host arm is missing and one behavioural question is
unmeasured; both are named at the end.

## The defect

Two cards mutate the chat array they get from `getContext()`, at eight sites:

```js
context.chat.push(msg)                              // insert a floor
context.chat.splice(msgInfo.index, 1)               // delete a floor
context.chat[msgInfo.index].mes = msgInfo.newContent // rewrite one in place
```

Upstream this works because `context.chat` **is** the live array. Iris hands over
a snapshot that crossed an origin, so a push lands in the copy, the card then
calls `saveChat()`, and the host stores its own array — the one without the new
message. Nothing throws. The card's own interface shows the message because it
reads the array it just changed; the reading view never had it; the next refresh
erases it.

This is the third instance of one shape (`chatMetadata`, `strategy.keys`, and now
`chat`): **upstream hands cards a live object and its idiom is to mutate it, and
every one of those idioms breaks silently against a snapshot.** Worth stating as
a class, because the remaining members have not been audited for it.

## What already exists

Checked rather than assumed — "it turns out to be built already" has happened
four times in this area:

| card mutation | host arm | state |
| --- | --- | --- |
| `chat[i].mes = …` | `script.setChatMessages` | **exists** — batched, atomic, and already goes through the swipe-aware write path |
| `chat.splice(i, 1)` | `chat.deleteMessage {chatId, id}` | **exists** — per floor, distinct from `chat.delete`, which removes a whole conversation |
| `chat.push(msg)` | — | **missing** |

So the host gap is one arm, not three. `createChatMessages` (the unbuilt member,
one card) is the same operation seen from the other side, and should be one arm
serving both façades rather than two that can disagree about what an append does.

## Mechanism: intercept, record, replay

Three candidates were considered.

**Diff the array on `saveChat`.** Rejected. Inferring which operation produced an
observed difference is guessing — a push and a splice can leave similar traces —
and constraint 1 says every mutation must either land or be **refused by name**.
A diff that cannot classify a change has no name to refuse it with.

**Proxy and dispatch immediately.** Rejected as the default, for a reason that is
upstream's rather than ours: a push does not draw anything upstream either. The
card's sequence is `push` (data) → `addOneMessage` (draw) → `saveChat` (persist),
and dispatching at push time collapses three steps the card is deliberately
sequencing.

**Proxy to record intent, replay on `saveChat`.** Chosen. The array and its
elements are wrapped so every mutation is recognised *at the moment the card
makes it*, appended to an ordered journal, and applied to the frame's own copy so
reads stay consistent. `saveChat()` replays the journal through the host arms
above, in order, and clears it.

Why this shape:

- **No inference.** The operation is known because it was intercepted, not
  reconstructed.
- **Refusals are immediate and named.** A mutation with no counterpart —
  `chat.sort()`, `chat.length = 0`, assigning a field other than the ones below —
  throws at the call site, inside the card's own stack, where the card author can
  see which line did it. Deferring that to save time would report it far from its
  cause.
- **Timing matches upstream.** Nothing persists until `saveChat`, exactly as
  upstream. A card that mutates and never saves persists nothing — also exactly
  as upstream.
- **Reads do not regress.** The proxy is transparent for every read; the live
  snapshot's existing behaviour is untouched. (Constraint 4.)

### Element proxies are required, not optional

`chat[i].mes = x` mutates the *message object*, not the array, so an array-level
proxy cannot see it. Elements are therefore wrapped too. This is the detail most
likely to be dropped as an implementation nicety, and dropping it reinstates the
silent loss for one of the three measured mutations.

### The journal is not a diff

Entries are the operations themselves: `{append, message}`, `{remove, id}`,
`{rewrite, id, text}`. `rewrite` replays through `script.setChatMessages` and
**not** through anything new — constraint 2, and the rule it protects (a floor's
text lives in its swipe list, so an edit that misses the list is undone by the
next swipe) has only ever been implemented correctly once.

### What a pushed message may contain

Constraint 5. The card supplies an arbitrary object; only the fields the host's
append arm accepts are forwarded, and the rest are dropped **with a report** —
silently discarding a field a card set is the same class of bug as this whole
document. Normalisation is against the measured call shape, which is still
needed (below).

## Replay is ordered, and "by index" is a trap

The journal replays **in the order the card made the mutations**, and that is a
correctness requirement rather than tidiness.

One of the two cards processes its work **back to front** —
`sort((a, b) => b.index - a.index)`, with the comment *"avoid index shift"* — and
inside that loop it mixes `splice` with in-place rewrites, saving once at the
end. Each index it passes is therefore relative to the array **as the earlier
operations in the same batch have already left it**.

Writing "replay by index" invites the reading that entries are independent and
may be sorted, batched, or deduplicated on the way out. They may not. Two
`splice` entries reordered produce different floors deleted, silently, and the
card's own back-to-front discipline — which exists precisely to make sequential
indices correct — is what breaks first. Batching the rewrites into one
`setChatMessages` is only safe for a run of consecutive rewrites with no
structural operation between them.

## Open items

1. **Host arm for append — for 72.** Needs the same swipe-list awareness as
   `setChatMessages`: a message arrives with `mes` and no swipe list, and the
   floor's text lives in its swipes. One arm should serve both this journal and
   the unbuilt `createChatMessages` member. The Proxy, journal and replay layer
   does not wait on it: an `append` entry with no arm is refused by name, which
   is constraint 1 working rather than a gap.
2. ~~Do cards call `saveChat()` after every mutation?~~ **Measured: yes.**
   Five sites after de-duplication (not eight — 3e re-counted by card and opening
   text), all of them saving, all on the same control flow, none behind a branch
   that could skip it. No site relies on `addOneMessage` alone to make an insert
   stick; three of the five are explicitly write-then-save-then-draw. Deferring
   the journal to `saveChat` is therefore faithful **and** complete for the
   corpus as it stands.
3. **`addOneMessage` / `printMessages`** are wiring-level and separate: they draw
   and do not store, and `chat.updated` already covers the redraw. They are not
   part of this journal.
