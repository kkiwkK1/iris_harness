# Card script sandbox — frozen policy

The last thing blocking real cards. 14 of 19 cards in the local corpus carry
script code — 47 scripts, 2.98 MB — and none of it can run yet.

This document is the contract three work streams build against. It is frozen the
way `@iris/protocol` was frozen: additions are cheap, edits are expensive.

## What is actually out there

Measured against the 19 cards in `data/default-user/characters`, decoded with
`@iris/character`. Not reasoned about, and not carried over from an earlier
count — an earlier pass here read only extension keys containing `script` and
so saw one of the three storage shapes.

| | |
|---|---|
| Cards with script code | **14 / 19** |
| Scripts | **47** (41 enabled, 6 disabled by their author) |
| Total script code | **2.98 MB** |
| Largest single card payload | **1.79 MB** |

Counted by running `extractScripts` over the corpus, not by grepping: 19 cards
decode, 14 carry scripts, 2 entries are genuinely empty (`content: ""`, and
disabled) and are the only things skipped.

### Three storage shapes, one meaning

Scripts live under two different extension keys, and one of them appears in two
serializations. All three normalize to the same thing.

```
extensions.tavern_helper = { scripts: [...], variables: {...} }         8 cards, 22 scripts
extensions.tavern_helper = [["scripts", [...]], ["variables", {...}]]   7 cards
extensions.TavernHelper_scripts = [{ type, value: {id, name, content} }] 3 cards
```

The third nests the script one level under `value`. All three cards using it
also carry `tavern_helper`, so on this corpus it is redundant — but a card
exported with only that key loses every script if the shape is unhandled.

The second is `Object.entries()` of the first — a `Map` that was serialized
through `JSON.stringify` somewhere upstream. An importer that handles only the
object form silently loses seven cards, which is how the earlier count came to
be low.

A script object is:

```ts
{ id, name, type, enabled, content, info, button, data, export_with? }
```

`enabled: false` occurs and must be honoured — a disabled script is shipped
inside the card, and running it because it is present would execute code the
card's own author switched off.

### The code is compiled, and it evals

The blobs are webpack output containing `eval()` per module. **This rules out
forbidding `unsafe-eval`**: a frame that does runs none of these cards. So
isolation comes from the frame boundary and from what the globals inside it are
wired to, never from restricting what the code may compile.

It does not rule out CSP. An earlier version of this section said it did, which
was too broad: CSP's other job — pinning *where code may come from* — is intact
and worth having.

```
script-src 'unsafe-inline' 'unsafe-eval' blob: https://*.jsdelivr.net https://raw.githubusercontent.com
```

That permits the eval these cards need while confining remote sources to the
whitelist below. `blob:` is not a loosening — live capture of the upstream
extension shows its own injection layer (predefine, height and viewport
adjusters) arrives via blob URLs, and a blob can only carry what is already in
the frame's memory; without it the machinery is blocked before any card code
exists, with symptoms that read as a broken card rather than a wrong policy. It is defence in depth and nothing more: **the host-side check
remains the one that counts**, because a page cannot be relied on to police its
own fetches, and the two are not equivalent.

## `parent.*` — what cards actually reach for

| Access | Sites | Disposition |
|---|---|---|
| `parent.SillyTavern` | 15 | Bridge to Iris's own context object |
| **`parent.document`** | **14** | **Virtual proxy — see below** |
| `parent.eventSource` | 8 | Bridge to `@iris/compat-tavernhelper`'s `EventBus` |
| `parent.innerWidth` | 6 | Real value; a window size is not a secret |
| `parent.extension_settings` | 6 | Bridge, per-card partition |
| `parent.event_types` | 6 | Bridge, static table |
| `parent.innerHeight` | 4 | Real value |
| `parent.TavernHelper` | 1 | Bridge, already built |

### The `parent.document` uses are mostly measurement

The count grew from 7 to 14 with the corrected extraction, but the *shape* of
the problem got smaller, not bigger. Every site is one of two things:

```js
window.parent.document.documentElement.clientWidth    // and clientHeight
$(window.parent.document.body)                        // and targetDocument = …
```

Broken down by member, over the 47 extracted scripts:

| `parent.document.…` | Sites |
|---|---|
| `documentElement` (`clientWidth` / `clientHeight`) | 10 |
| `body` | 2 |
| bare, assigned to a local (`targetDocument = …`) | 2 |

**Ten of the fourteen read the viewport size**, invariably as a fallback beside
`parent.innerWidth`, which is already allowed. Answering those truthfully grants
nothing: the number is already available to the frame through its own
`window.screen`, and a card laying itself out against the viewport is doing
something legitimate. Two want `document.body` as a mount point.

So the proxy has two real members and a wall behind them — which is why this
policy is small to implement, despite the count doubling when the extraction was
corrected.

## Policy (decided by the user, 2026-08-31)

**Virtual proxy by default, with per-card escalation.**

### The virtual document

`parent.document` yields an object that is not the host document:

| Member | Behaviour |
|---|---|
| `documentElement.clientWidth` / `clientHeight` | The real viewport size |
| `body` | The card's **own container element**, not the host body |
| `getElementById`, `querySelector`, `querySelectorAll` | Scoped to that container |
| `createElement`, `createTextNode`, `createDocumentFragment` | Real, unattached — a node has no authority until it is inserted |
| everything else | Absent. Reading it throws `UnsupportedApiError` naming the member |

A refusal throws rather than returning `undefined`. `undefined` from a DOM
lookup is indistinguishable from "not found", so a card would take a policy
decision for a missing element and fail somewhere later with no trace of why.

### The container

One element per running script, owned by the shell, positioned where a card's
UI belongs. Writes inside it are the card's business. It is removed when the
script is disposed, which is what makes the whole thing reversible — the same
property Cordis gives every other plugin in Iris.

### Escalation

A card may be granted the real document, per card, by the user, never by the
card. Requirements:

- The grant is **explicit and per-card**, stored against the card's identity.
- The prompt states what is being granted in terms of consequence, not API:
  a granted card can read and alter anything on the page, including other
  chats.
- A card **may not ask**. There is no API for requesting escalation, because a
  request is a prompt the card authored, and a card that can put text in front
  of the user can argue for its own privileges.
- The grant is revocable, and revoking it takes effect on next run.

Default-deny is what makes the default safe; the grant exists so that "Iris
cannot run this card" is never the final answer.

## Scope: `script-src` governs code, and cards load more than code

Measured against the live instance (2026-09-01): real cards also pull
stylesheets and fonts (`fonts.googleapis.com` — six cards), images and textures
(catbox, ibb.co), and in one case an **entire card interface fetched at runtime**
(`$('body').load('https://files.yuzuki-rii.xyz/…')`). None of that is touched by
`script-src`; each has its own directive. Policy:

- **Default**: `style-src`/`font-src` additionally allow `fonts.googleapis.com`
  and `fonts.gstatic.com` — high coverage, no execution. `img-src` stays
  `data: blob:` and `connect-src` stays closed, because an open image or fetch
  channel is an exfiltration path for everything card-visible in the frame.
- **Per-card network grant**: a second grant beside the document grant, user
  set, never card requested, widening `img-src`/`connect-src`/`style-src` to
  `https:` for that card. This is what makes a card whose whole UI lives on its
  author's host usable without opening the channel for every card. `http:` URLs
  stay refused even under the grant (one measured casualty: a card's version
  check; recorded, accepted). The grant never widens `script-src`: letting a
  card load its author's images and letting it execute its author's code are
  two different decisions, and the grant exists only for the first — pinned by
  test, granted and ungranted `script-src` identical byte for byte.
- **Refusals must out-shout the card's fallback.** Live finding: a blocked card
  showed its author's own "your Tavern is broken, check the console" message
  while Iris said nothing visible — the policy said "refused with a message
  naming the host" and the product delivered the opposite. The frame bootstrap
  listens for `securitypolicyviolation` and posts the blocked host to the
  shell, which displays the refusal beside the frame, naming the host and the
  grant that would allow it. A refusal the user cannot see is indistinguishable
  from a bug in whatever the card does next.

Cards that solicit credentials (three measured carry settings panels asking the
user for an API endpoint and key) get no special channel: there is no "card
holds credentials" tier, and the network grant does not create one — a granted
card can call out, but Iris never hands it anything of the user's.

## Deliberate divergences from upstream

- **Frame height sync is one frame late.** Tavern Helper's iframes size
  themselves by writing `frameElement.style.height` from inside — a child
  reaching directly into its parent, which only same-origin frames can do.
  Cross-origin that line throws, so Iris measures inside the frame and
  `postMessage`s the height out for the shell to apply. The visible cost is one
  frame of latency on resize; it is the known price of the frame being a real
  boundary, not an implementation choice that could be optimized away.
  (Verified live 2026-09-01: the probe frame sized to its content through this
  path.)

## Remote imports

Card scripts import from CDNs. Whitelist, enforced host-side:

```
*.jsdelivr.net        (any hostname — measured: 14 of 15 real imports use
                       testingcf.jsdelivr.net, only 1 uses cdn.)
raw.githubusercontent.com
```

Enforced on the host, not in the page: the browser cannot be trusted to police
its own fetches, and a card that reaches an unlisted host must be **refused with
a message naming the host**, never silently allowed and never silently dropped.

The frame's own `script-src` carries the same list. That is a second layer, not
a second enforcement point — if the two ever disagree, the host's answer is the
real one.

## Work split

| Stream | Owner |
|---|---|
| `@iris/script` — normalize the three shapes, extract, order, honour `enabled` | coordinator |
| Contract additions (script list, grant get/set, fetch proxy) | coordinator |
| Host-side script storage, the whitelisted fetch proxy, grant persistence | A |
| The frame runner, the virtual document, the grant prompt | B |

The virtual document's *policy* is this document. Its *implementation* is B's,
including how the container is placed, which is a typographic decision in a
design B owns.
