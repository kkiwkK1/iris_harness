# Card-script cohabitation — design

For `initializeGlobal` / `waitGlobalInitialized`. Written before the code, per the
same discipline as `AUTORUN.md`.

## What the feature actually is

One script of a card publishes an object; the card's other scripts wait for it
and then use it. OVERLORD is the canonical shape: one script is a single line
importing the MagVarUpdate bundle, and three others wait for `Mvu` before doing
anything.

Upstream can implement this trivially because every script frame is **same-origin
with the parent**, so a live object can be handed across a window boundary by
reference. Ours are opaque-origin `srcdoc` siblings. A function cannot cross that
boundary at all, and no amount of `postMessage` makes one, because what the
consumer wants is `Mvu.getMvuData(...)` — a live interface, not a value.

So the boundary has to move: **a card's scripts share one realm.**

## What the corpus says about sharing a realm

Measured across the 19 local cards (14 with scripts, 47 scripts, 12 cards with
more than one):

- Only **2** multi-script cards write a `window` global at all.
- **Zero** cards have two scripts writing the *same* global.
- Card scripts run as `<script type="module">`, so top-level `let`/`const`/
  `function` never reach `window`. Co-located modules share a window, not a scope.

OVERLORD is the closest thing to a counter-example and it is not one: its ERA and
MVU families are two versions of one system and declare **identical** top-level
names (`Exp_list1`, `alignment_list`, `woman_likeability_list`). They collide in
no arrangement, because module scope already separates them.

**No measured obstacle to sharing a realm.**

## What sharing a realm breaks, and the fix

One frame per card, one `<script type="module">` per script. Then
`waitGlobalInitialized` degenerates: `_.has(window, 'Mvu')` is simply true once
the provider has run. But three things stop being free.

### 1. `window.parent` is where a provider publishes

MVU does not call `initializeGlobal`. It writes:

```js
_.set(window.parent, 'Mvu', mvu)
eventEmit('global_Mvu_initialized')
```

and upstream's own `initializeGlobal` also writes to the parent window. The shared
namespace *is* the parent, for script frames.

Today the virtual parent's `set` throws unconditionally. It has to accept writes
— but **asymmetrically**, and the asymmetry is the whole safety property:

| operation | behaviour |
| --- | --- |
| write an unbridged name | stored in a **per-card** bag |
| read a name that was written | returns it |
| read a name nobody wrote | **refuses by name, as today** |
| `has` / `in` on any name | answers, never throws |

A name nobody wrote must keep making noise. Otherwise a card reaching for a host
API we do not have — `parent.toastr`, say — degrades from a named refusal to a
silent `undefined`, which trades eleven runs' worth of failure discipline for the
convenience of a shared slot. `waitGlobalInitialized` polls with `_.has`, so
`has` answering `false` without throwing is sufficient for it.

Bridged members (`document`, `SillyTavern`, `extension_settings`, `eventSource`,
`event_types`, `TavernHelper`) keep exactly today's behaviour. The outward wall —
CSP, opaque origin, the document grant — does not move. This is intra-card
sharing, not a hole in the frame.

### 2. `getScriptId()` loses its answer

One frame, four scripts, one bare global. MVU calls it 17 times and partitions
its variables by the result, so a wrong answer means four scripts sharing one
variable partition — which reads as state that was never written.

Sixteen members are affected, not one. `src/sandbox/identity.ts` classifies every
member of the surface, and two rules produced the list rather than intuition:

- **Anything taking a `VariableOption`** partitions by `getScriptId()`.
- **Event registration and teardown** belong to the registrant. Measured
  upstream: the listener registry is keyed by iframe name and `eventClearAll`
  deletes only that frame's entry, fired from `predefine.js` on `pagehide` so a
  script's listeners die with the script. A shared registry would let one
  script's teardown silently remove its siblings' listeners — something upstream
  structurally cannot do.

`eventEmit` is the deliberate exception: emission reaching every script of the
card is the point of a card-wide bus.

The binding mechanism is a **module-scope preamble** per script. Each script gets
its own `<script type="module">`, and module scope shadows the global, so each
one can be handed its own `getScriptId` and its own event-registry handle without
either being visible to its siblings.

`identity.test.ts` walks the live surface and fails on any member that has not
been classified, in either direction — an unclassified new member, or an entry
left behind after a rename. A list like this rots, and the rot is invisible until
a card reads the wrong partition.

### 3. "One script's failure does not stop the next" changes meaning

Today the runner starts scripts in card order and a failure is isolated because
the next iteration simply continues. Co-located, the browser gives isolation for
free between module tags — but the common failure stops being a throw.

`waitGlobalInitialized('Mvu')` **hangs** when nothing ever publishes `Mvu`.
Upstream bounds this: `async-wait-until` times out after 5 s and the `catch`
swallows it, so the script continues. We copy that behaviour, and the state line
has to say what happened during those five seconds.

So the per-script criterion does not relax:

- A hung script shows **what it is waiting for and for how long** —
  `waiting for Mvu, 3s` — not a generic "starting…".
- A card is not "running" because its other scripts are. Sibling success must not
  paper over a stuck script; under co-location that is far easier than it was
  with one frame each, because the neighbours are visibly fine.
- The `silent` timeout stays anchored at *ready*, which is now per frame and so
  per card. Hang detection is per script and separate.

## Order of work

1. `identity.ts` + its guard — **done**, and it is what makes the rest decidable.
2. The virtual parent's asymmetric read/write, with the refusal preserved for
   names nobody wrote.
3. One frame per card, one module tag per script, with per-script preambles for
   the sixteen identity members.
4. Per-script hang reporting, naming the awaited global.
5. `SANDBOX.md`'s virtual-parent section, in the same change as the wiring.

## What this does not do

- It does not implement `initializeGlobal` as the mechanism. It can be provided
  for cards that call it, but the provider that matters does not.
- It does not let scripts of *different* cards see each other. The bag is
  per-card, and two cards are two frames.
- It does not move the outward wall in any respect.
