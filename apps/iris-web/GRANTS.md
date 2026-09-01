# Permission traps on the road to auto-run

Input for the auto-run policy. Every trap below was paid for in this repository,
not imagined: each one shipped, and each was found by something other than the
judgment that wrote it.

The reason they matter more for auto-run than for the probe is a single change in
who is present. Today a card runs because someone opened a panel and pressed a
button, so a wrong answer about permissions is made in front of the person it
concerns. Auto-run moves that decision to *chat open* — no panel, no button, no
one looking. **Every trap here gets quieter, not louder, the day scripts start
themselves.**

---

## 1. A grant outlived the card it was given to

**What happened.** Character ids are minted with `uniqueId(toId(name), existing)`
against the cards that currently exist. Deleting "Aria" frees `aria`, so the next
card of that name is handed the same id. Host-side, `ScriptPolicyStore` had no
`forget`, so `documentGranted` stayed on that id — a new card inherited page
access its user had never granted it.

The browser half had the same bug independently. `loadScripts` returns early when
its cache already names the character, and `deleteCharacter` cleared neither
`scriptsFor` nor `documentGranted`.

**The tuition.** The host fixed its half and was correct. The browser's early
return then meant the question was never asked, so the cache answered `true`
without consulting the fix. **Both halves' test suites stayed green, and would
have stayed green forever** — the host's tests should not mock a browser cache and
the browser's should not run a real host. Both boundaries were drawn correctly and
the leak sat on one.

**Constraint on auto-run.**

- A grant must be **re-resolved from the host at the moment of running**, never
  read from a cache keyed on `characterId`. Id reuse makes that key unsound, and
  auto-run removes the person who would have noticed the wrong answer.
- Any state the shell caches per character must be invalidated where identity can
  change hands, and the policy should name those moments rather than rely on
  someone remembering to add a `forget`.
- Composition needs an owner. If auto-run spans both halves, one end-to-end check
  has to exercise *deleted card → reimport → open chat*, because neither suite
  can see that path from inside its own boundary.

---

## 2. A permission outlived its subject with no deletion at all

**What happened.** The sandbox probe's network grant was panel state, partitioned
by nothing. Switching to a different card left the box ticked, and that card's
script reached the network on a permission granted to a different one. Its label
said "Grant **this run** the network" while the behaviour was per-panel.

**The tuition.** This was not found by auditing existing revocation code — there
was none to audit, because no one had ever written a `forget` for it. It surfaced
from asking a rule of a thing that did not exist yet. The first framing of that
rule was also too narrow: *deletion is the only moment an id changes owner* is
true of the host's id binding and misses this case entirely, where nothing was
deleted and the subject simply changed.

**Constraint on auto-run.**

- **Content rebinds by name; permissions never.** Chats survive a card being
  deleted and reimported, because carrying on playing is what the user meant.
  Grants must not, because the user granted them to a card that is gone.
- Re-anchor a permission whenever **what it was granted to stops being what is in
  front of you** — deletion *and* switching. Auto-run fires on chat open, which is
  precisely a subject change, so this is the common path and not the edge case.
- Dev-only surfaces are not exempt. A harness that quietly widens a policy is the
  last place that policy should be observed from.

**The counter-case, which belongs in the policy beside the rule.** Script
variables are content by this test, yet the host forgets them on delete — correct,
because upstream stores that table in the card file, so a reimported card is meant
to start from the `data` it ships. A rule strong enough to force an answer also
manufactures false positives, and someone applying it as a checklist would file a
bug here, or "fix" it and delete upstream behaviour. **Ship the rule with its
known exceptions and their reasons, or it will be executed instead of used.**

---

## 3. The panel described behaviour the product did not have

**What happened.** The card-scripts panel read *"N of M will run when you open a
chat with this card."* `runCard` had exactly one call site in the repository, in
the dev probe. Opening a chat ran nothing. Intent had been written as fact.

**The tuition.** It survived every test and a visual review, and surfaced only
because a peer asked a scoping question about something else. Nothing in the
codebase could have caught it: the sentence was well-formed, the component
rendered, the count was correct.

**Constraint on auto-run.** This is the trap that *inverts* when auto-run lands —
the sentence becomes true, which is exactly why it needs a clause rather than a
fix. **Discharged**: the panel and the wiring changed together, and the heading
now reports what the scripts are doing rather than how many are switched on.

The clauses stand for whatever replaces it:

- **Copy and wiring land in the same change.** A settings panel is where a user
  decides what a card may do; copy describing an unbuilt pipeline as current
  behaviour makes that decision on false information, which is the same fault as a
  permission control whose label overstates its scope.
- Once scripts start themselves, the panel must state the **actual runtime
  state** — running, not running, refused, and why — not a static count. The
  difference between "2 of 2 enabled" and "2 of 2 running" is the entire question
  a user opens that panel to answer.
- Wording on a permission surface **is** the scope of the permission. There is no
  separate copy review for these strings.

---

## 4. What auto-run removes that the probe supplies

Not a trap that has been paid for yet — a gap visible from here, and cheaper to
design than to discover.

Everything the sandbox reports about itself currently lands in the probe's harness
record: `bootstrap-error` before a token exists, the eight-second silence timeout,
the missing-globals banner, refusals naming the member, CSP violations, the run
outcome. **Auto-run has nowhere to put any of it.** A card that fails on chat open
would fail into a panel nobody opened.

**Constraint on auto-run.** **Discharged**, and the gap proved real on the way:
the first version of the run path failed without producing any of the signals
below, because a frame that is never inserted into the document never runs and so
never has anything to report. The landing points now exist *and* the two silences
with no innocent reading — a frame that never entered the document, and one that
never became ready — are reported rather than waited on.

- Decide, in the policy, where a card's failure appears when no one asked it to
  run. Silent failure is the default outcome otherwise, and this half spent eleven
  runs establishing that a cross-origin frame's errors never reach the parent
  console on their own.
- A failing card must not take the conversation with it. The chat is the product;
  the card is an enhancement.
- The grant prompt cannot be part of the run path. If a card needs page access at
  chat open, the answer is "not granted, and here is where to grant it" — not a
  modal in front of a conversation the user came to read.

---

## The shape shared by all four

Three of these were permissions surviving something, and the fourth was an
interface describing a capability it did not have. What unites them is that **none
could be seen from inside the half that contained it**: two needed the other half,
one needed a rule applied before the code existed, one needed a person to ask a
question.

The auto-run policy should assume the same. Whatever it specifies, the check that
catches its failures will not live in the same place as the failure.
