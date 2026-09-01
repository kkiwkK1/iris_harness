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

One element per **card**, owned by the shell, positioned where a card's UI
belongs. It was one per script until the scripts of a card had to see each
other's globals. Writes inside it are the card's business. It is removed when the
script is disposed, which is what makes the whole thing reversible — the same
property Cordis gives every other plugin in Iris.

### `parent` as a card's own shared namespace

A card's scripts occupy **one frame**, and `window.parent` is the namespace they
publish to each other through. That is not a convenience: upstream's script
frames are same-origin siblings, so a provider hands a live interface across by
reference — `_.set(window.parent, 'Mvu', mvu)`, which is what the real provider
does rather than calling `initializeGlobal`. A live object cannot cross an opaque
origin, so the only way to keep that contract is for the scripts that need to see
each other to share a realm.

Reads and writes are **asymmetric**, and the asymmetry is the safety property:

| operation | behaviour |
| --- | --- |
| write a name the frame does not bridge | stored, scoped to this card |
| read a name that was written | returns it |
| read a name nobody wrote | **`undefined`, plus a one-time named warning** |
| `has` / `in` / `hasOwnProperty` | answers, never throws |
| write or delete a bridged member | refused |

A name nobody published keeps making noise — but it makes it as a **warning, not
a refusal**, and the difference is load-bearing.

Throwing was the first attempt and it broke the namespace it was protecting.
Upstream's cross-script coordination *opens* by reading a slot that does not
exist yet: `_.get(window.parent, 'th_unique_check.<id>', new Set())`, then writes
it back. A refusal on that first read threw inside an init that swallows its own
exceptions, so MVU never reached `_.set(window.parent, 'Mvu', …)` and every
consumer waited forever on a publish that had already been abandoned. Reading an
absent property is not an error on a real parent window, and a frame that treats
it as one cannot host a card that coordinates.

So the frame yields what upstream yields and says what upstream does not: the
read returns `undefined`, and the frame reports it once, naming the member and
stating that this **is not a claim the host has no such member**. Silence there
is what turns a missing host capability into a failure three steps away; a
refusal there is what turns a legitimate first read into a dead card.

`hasOwnProperty` is listed deliberately: lodash's `_.has` is built on it and does
**not** go through a proxy's `has` trap, so a namespace that answered `in` but not
`hasOwnProperty` would leave `waitGlobalInitialized`'s poll returning false
forever with both halves apparently correct.

### The frame carries the card's own script list

Upstream keeps `<div id="tavern_helper">` on the host page with one
`<div data-type="script" data-script-id="…">` per running script, and cards read
it to elect a single active instance of themselves. With a card's scripts
sharing one frame, the frame is that page for them, so it carries the same
structure in its own document — copied from `src/index.ts` and
`panel/script/ScriptItem.vue` rather than guessed, because an election that
queries an attribute we invented finds nothing and silently elects nobody.

A card in real SillyTavern can already see and modify those elements — its `$`
is the parent's — so this is upstream-faithful visibility rather than new
exposure, and the real page is never touched.

For the same reason the **shared** `getScriptId` is fixed at the first script of
the frame. A card body gets its true identity from the per-script preamble; code
the card *imports* is its own module and reads the global, and an election that
registers under one value and compares against another never enables anything.

**This is intra-card sharing and nothing else.** Two cards are two frames with
two bags. The outward wall — opaque origin, CSP, the document grant — is
unchanged, and sixteen members that depend on *which script* is asking are bound
per script inside the shared realm so that co-location does not silently merge
their variable partitions or their event teardown.

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
- **A grant dies with its card, and id reuse does not inherit it.** Character
  ids are minted from names against the cards currently present, so deleting
  "Aria" frees `aria` for the next card imported under that name. Content
  rebinds across that reuse — chats belong to the name, as upstream models it —
  but permission never does: the user granted a card that no longer exists, and
  the thing that would carry the grant across is the host's own id reuse, not
  anything the card wrote. Deletion is the one moment a characterId changes
  owners; every per-character store must answer "content or permission?" before
  it is written. (Found live, both halves: the host kept the policy record, and
  the browser's cache separately kept answering for the deleted card without
  asking — two correct halves that did not make a correct whole.)

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

## Preset libraries follow upstream, unpinned — and why that is acceptable

Upstream's script frames load Vue and vue-router from jsdelivr **without version
pins** (`/npm/vue/dist/...` resolves to latest); Iris mirrors the list and the
unpinning. This is a supply-chain property, not a behaviour quirk, and it is
acceptable for exactly one reason: **the frame is the boundary, and its contents
are untrusted by construction.** Cards already import arbitrary whitelisted
code; a library that updates itself changes nothing about what the frame is
allowed to reach. Pinning would buy no security and would cost compatibility —
cards are written against the user's SillyTavern, which runs latest, so a
pinned Iris would break with those cards on a different day than upstream does.

**Condition attached**: this reasoning holds only while the frame is a real
boundary. Any future weakening — broader grants, relaxed script-src, same-origin
frames — reopens this decision before it reopens anything else.

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

### Anything the frame imports must send CORS headers

**Module scripts are always fetched in CORS mode.** Not "when cross-origin" —
`<script type="module">` and `import` use request mode `cors` unconditionally,
where a classic script uses `no-cors`. The frame is an opaque origin, so *every*
import it makes is cross-origin, including one aimed at Iris's own host.

This is invisible until you serve a card's dependency yourself. Direct CDN
imports work because jsDelivr sends `Access-Control-Allow-Origin: *`; the moment
the host proxied those bundles, the same mechanism failed with
`Failed to fetch dynamically imported module: blob:null/…` — no CSP violation,
because CSP allowed it, and no timeout, because the response arrived and was
simply not delivered.

So a host route the frame imports from must send `Access-Control-Allow-Origin`.
`*` rather than `null`: every sandboxed frame's origin is `null`, so it
identifies nobody and only looks precise. It grants nothing either, since the
bytes are public CDN content that already carried `*`, and a CORS header governs
whether a response may be **read**, never whether a request may be **sent**.

Note what this does *not* buy: a custom header still needs
`Access-Control-Expose-Headers` to be readable cross-origin, so `x-iris-reason`
remains invisible to the frame. It is read by the shell, which is same-origin
with the host — putting the diagnostic where its reader already is, rather than
opening the frame further to reach it.

### Remote imports are routed through the host

Every chat opens a fresh opaque origin and HTTP caching is partitioned by
origin, so a card's bundle is a cold fetch every time — measured at 307 KB over
9–12 seconds, four timeouts in six openings. Upstream never pays this: its
script frames are same-origin with the page and share its cache.

The route is:

```
GET /iris/script-bundle?url=<encodeURIComponent(upstream URL)>
```

Written here because it is the one thing about this feature that **both trust
domains must agree on and neither can import from the other**. A query parameter
rather than a path segment: a URL inside a path needs double encoding and is
still rewritten by path normalisation. A mismatch between the halves is a 404,
which `import()` reports as "failed to fetch dynamically imported module" — a
sentence that names nothing and sends the reader looking at the network.

The browser rewrites **only** imports that were already allowed. A URL the
allowlist rejects is left exactly as written, so the frame's CSP refuses it as
before; rewriting it to a same-origin path would turn a request that never left
the browser into one the host must field, which is capability the card did not
have. Diagnostics unwrap the routing and name the bundle the card asked for.

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
