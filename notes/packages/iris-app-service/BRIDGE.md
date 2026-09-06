# Bridging a card's own generation calls back to the host

A card script can ask for model output two ways. This is the archived
specification for both, measured from the installed SillyTavern and from a real
card, so that whoever implements it — probably not the person who wrote this —
starts from the contract rather than from the source.

**Nothing here is implemented.** Phase two in particular is recorded and
deliberately not built: it waits for a real consumer, because a compatibility
surface written to a specification rather than to an ecosystem is mostly
untested surface.

Measurements are attributed. Where a thing was not measured it says so, because
"not measured" and "not present" are different claims and the difference is the
whole value of the document.

---

## 0. The finding that sets the order of work

**The default path does not fetch anything.** (3e, reading the sample SPA's
286 KiB script in full.)

```js
raw = variableApi.enabled
  ? await callSecondaryApi(variableApi, [{ role: 'user', content: prompt }])
  : await th.generate({ user_input: prompt, should_stream: false });
```

`API_DEFAULTS = { enabled: false, url: '', key: '', model: '', … }`. Every one
of the card's five `fetch` sites is reachable only after a user opens a settings
panel, types a URL and a key, and turns the switch on.

So:

- **Phase one — bridge `TavernHelper.generate`.** Out of the box this is the
  only path, and it makes the card run.
- **Phase two — the `/api/backends/*` routes.** Recorded below, built when
  something actually asks for it.

---

## 1. Phase one: `TavernHelper.generate`

### 1.1 There are two upstream functions and only one of them assembles

From `JS-Slash-Runner/src/function/generate/types.ts`:

| | `GenerateConfig` (`generate`) | `GenerateRawConfig` (`generateRaw`) |
| --- | --- | --- |
| preset | `preset_name?: 'in_use' \| string` | — |
| history | `max_chat_history?: 'all' \| number` | — |
| prompts | — | `ordered_prompts?: (PlaceholderPrompt \| RolePrompt)[]` |
| shared | `user_input`, `should_stream`, `should_silence`, `overrides`, `injects`, `custom_api`, `tools`, `tool_choice`, `json_schema`, `image`, `generation_id` | same |

`generate` means *produce a reply the way this chat normally would* — preset,
world info, history — with `user_input` as the final user message. `generateRaw`
means *send exactly what I give you*.

**The card calls `generate`.**

### 1.2 The host's existing method is the other one

`script.generateRaw` takes `{ chatId, prompt, systemPrompt? }` and sends a single
user message (`service.ts`, `#generateRaw`). No preset, no world info, no
history. The name matches upstream's `generateRaw` and so does the behaviour.

**Mapping `th.generate` onto it would not fail — it would answer.** The card gets
a reply generated with no persona, no lorebook and no conversation, which is a
different thing from what it asked for and reports as success. That is the
failure this section exists to prevent.

### 1.3 What is missing

One method, not one field. Both halves already exist:

| | assembles preset + history | writes to the log |
| --- | --- | --- |
| `chat.send` / `TurnDriver` | yes | **yes** — wrong for this |
| `script.generateRaw` | **no** — wrong for this | no |
| what `generate` needs | yes | no |

`#contributions` + `#history` + `assemble` is the first half; `#generateRaw`
already proves that streaming through `#stream` without persisting works. The
proposed shape:

```ts
'script.generate': { chatId, userInput, systemPrompt?, maxHistory? } → { text }
```

`maxHistory` carries upstream's `max_chat_history: 'all' | number`. The other
`GenerateConfig` fields — `injects`, `overrides`, `tools`, `tool_choice`,
`json_schema`, `image` — are **deliberately absent**: the corpus has no consumer
for any of them, and a field added for a hypothetical caller is surface nobody
has tested.

`should_stream` is not needed. Measured (3e): the stream is consumed by
`eventOn('js_stream_token_received_incrementally', …)` which only counts
characters into a `data-received` attribute as a progress indicator. **The body
comes from the awaited return value**, so a non-streaming implementation loses a
progress bar and no correctness.

---

## 2. Phase two: the ST-compatible backend routes

Archived, not implemented. Supply side measured by d7 from
`E:/sillyTavern/SillyTavern/`; consumer side by 3e from the sample card.

### 2.1 The gate that decides whether the card uses them

One condition, shared by both routes (3e):

```js
const st = window.SillyTavern || (window.parent && window.parent.SillyTavern) || null;
if (st && typeof st.getRequestHeaders === 'function') { /* use the proxy */ }
```

No version check, no probe, no other member. **Expose a `SillyTavern` object with
a `getRequestHeaders` function and the card will route through these endpoints.**

### 2.2 `POST /api/backends/chat-completions/generate`

Mounted at `src/server-startup.js:180`; handler at
`src/endpoints/backends/chat-completions.js:2157`.

**What the card sends** (3e; `base = String(url).trim().replace(/\/+$/, '')`):

```js
body: {
  messages,                                     // [{ role, content }]
  model,                                        // with a leading `models/` stripped
  max_tokens: Math.max(200, …),
  temperature: clamped to [0, 2],
  stream: false,                                // always
  chat_completion_source: 'custom',
  group_names: [],
  custom_prompt_post_processing: 'strict',
  reverse_proxy: base,
  proxy_password: '',
  custom_url: base,
  custom_include_headers: key ? `Authorization: Bearer ${key}` : '',
}
```

**Four things a straightforward implementation gets wrong** (d7):

1. **`/status` is POST, not GET.** There is no GET route in the file (§2.3).
2. **The outbound body is a whitelist rebuild, not a pass-through.**
   `chat-completions.js:2553-2570` constructs a new object from fifteen named
   keys plus per-source `bodyParams`. Anything else in the inbound body is
   dropped **silently**. What the card sends and what the upstream provider
   receives are two different sets with no warning between them.

   **The fifteen are a baseline, not a ceiling** (d7, correcting an earlier
   report of this section). `mergeObjectWithYaml(bodyParams, request.body.custom_include_body)`
   at `:2319` lets a CUSTOM-source caller put arbitrary keys into `bodyParams`,
   which `:2570` spreads into the outbound body. So there are **three** escape
   valves on CUSTOM, not two — see §2.7.
3. **A non-streaming upstream failure answers `200`.** `:2611` sends
   `{ error: { message }, quota_error }` with no status code, so Express defaults
   to 200, and `message` is `fetchResponse.statusText` — *not* the upstream error
   body, which only reaches the server's own console at `:2609`. **A 200 on this
   route is not evidence of success.**
4. **`request.body.messages` is rewritten in place**, at six sites before the
   outbound body is built: `postProcessPrompt` (`:2164`), `embedOpenRouterMedia`
   (`:2214`, `:2282`), `addOpenRouterSignatures` (`:2283`),
   `cachingSystemPromptForOpenRouter` (`:2286-2288`), `addAssistantPrefix` /
   `setJsonObjectFormat` (`:2442-2443`). A bridge treating inbound messages as
   immutable behaves differently from upstream.

Point 3 and the consumer side corroborate each other from opposite ends, which
is why both are trusted: d7 read that a 200 can carry a failure; 3e read that the
card **does not trust a 200** and falls back unless
`choices[0].message.content` (or `data.content`) is a non-empty string. A 200
with empty content triggers the direct-connection fallback.

**Streaming is a raw pipe.** `:2592-2594` hands off to `forwardFetchResponse`
(`src/util.js:709-756`), which copies the status, streams `from.body.pipe(to)`
and never reframes. SSE frames are the upstream provider's own bytes — ST neither
parses nor rewrites them. One rewrite exists: **`401` becomes `400`**
(`util.js:718-720`), to avoid resetting the client's Basic auth.

**Client disconnect aborts upstream** (`:2531-2535`) — note it calls
`request.socket.removeAllListeners('close')` first, clearing listeners Express
and Node installed themselves. Worth understanding before copying.

**Error table** (d7):

| case | status | body |
| --- | --- | --- |
| no body | 400 | `{ error: true }` |
| unsupported source | 400 | `{ error: true }` |
| missing key | 400 | `{ error: true }` |
| upstream non-2xx, non-streaming | **200** | `{ error: { message }, quota_error }` |
| exception | 502 | `{ error: { message, …error } }` |
| upstream non-2xx, streaming | upstream's, 401→400 | upstream's raw text |

By this repository's own rule — a refusal is thrown, named, and carries evidence
— **upstream satisfies none of the first three rows.** Whether to reproduce that
shape is a decision for whoever builds this; reproducing it means the card
cannot treat 200 as success, which is what it already assumes.

### 2.3 `POST /api/backends/chat-completions/status`

`chat-completions.js:1735`. **Its purpose is fetching a model list, not
liveness.** The card calls it from `fetchSecondaryModels` and reads the result
three ways: `data.models`, else `data.data`, else `data` itself if it is an
array; maps each entry through `typeof x === 'string' ? x : x?.id`; an empty
result throws `'接口没有返回模型列表'` (3e).

Upstream forwards `GET {apiUrl}/models` (`:1987-1997`) and passes the body
through unchanged (`:2025`). **Failures answer 200** — `{ error: true, data: { data: [] } }`
at `:2060`, `{ error: true }` at `:2065-2068`. So the card's health check is
*"does the body contain `error: true`"*, not the HTTP status.

**One upstream bug, not to be reproduced:** the COHERE normalisation at
`:2027-2031` runs *after* `statusResponse.send(data)` at `:2025` and therefore
affects nothing. It is upstream's oversight, outside our compatibility surface,
and not ours to fix either.

### 2.4 `getRequestHeaders()` returns exactly two headers

`public/script.js:645-656`:

```js
{ 'Content-Type': 'application/json', 'X-CSRF-Token': token }
```

No Authorization, no custom headers. The token comes from a startup
`fetch('/csrf-token')`. The card never inspects an individual header — both call
sites spread the whole object and then override `Content-Type` (3e), so
`getRequestHeaders` need only return a plain object.

**A second source d7 flagged:** `public/script.js:665-666` installs a global
`$.ajaxPrefilter` that sets `X-CSRF-Token` on **every** jQuery AJAX request. A
consumer-side measurement that only reads explicit header construction misses
that path.

### 2.5 Credentials: the card never holds one

`:2306` resolves the key server-side via
`readSecret(request.user.directories, SECRET_KEYS.<source>, request.body.secret_id)`
and injects `Authorization: Bearer …` at `:2586`. The client sends a
**reference** (`secret_id`), never a secret. With `reverse_proxy` set, the key
comes from `request.body.proxy_password` instead.

This matches the constraint on our side — the key stays host-side and is never
echoed — and it means the card's own "base URL + api key" fields are the branch
that must be **ignored or refused**, not honoured. This route may only use the
connection the host is configured with; a card naming its own endpoint is
precisely what is being blocked.

### 2.5b None of the card's twelve body fields is decoration

Counted field by field against upstream's consumption points (3e):

| the card sends | upstream's use |
| --- | --- |
| `messages` `model` `max_tokens` `temperature` `stream` | forwarded — they are in the rebuild table |
| `chat_completion_source: 'custom'` | control: selects the branch |
| `reverse_proxy` / `custom_url` | control: routes to the user's base URL |
| `proxy_password` | control: the credential |
| `custom_include_headers` | control: becomes outbound headers |
| `custom_prompt_post_processing: 'strict'` | control: `:2161`; a valid enum (`prompt-converters.js:23`) |
| `group_names: []` | control: fed to post-processing (`prompt-converters.js:53`) |

**So this is not "five forwarded fields and seven that can be ignored."** Four of
the control fields — `reverse_proxy`, `custom_url`, `proxy_password`,
`custom_include_headers` — together mean *use these credentials against this
third-party endpoint*.

A bridge therefore has two honest options and one dishonest one. It may
implement that control semantics in full, or it may **refuse and let the card
fall back** (a non-ok response, or an ok response with empty content — either
triggers the card's direct-connection path). What it must not do is implement
only the five forwarding fields: that answers with the host's own provider a
question the card meant to ask somebody else, and reports success. A confidently
wrong answer is the failure class this whole document exists to avoid.

The measured field count on the general path, for scale (d7): 56 distinct
`request.body.*` reads in `chat-completions.js` plus three in
`prompt-converters.js` — `char_name`, `user_name`, `group_names`, reached through
`getPromptNames(request)` passed into `postProcessPrompt` at `:2164`. **Those
three are consumed in a different file from the one that reads them**, which is
how they look like dead fields to a single-file search.

### 2.5c A missing name means no prefix, not an empty prefix

An implementation requirement, not a tolerance. The card sends **no**
`char_name` and **no** `user_name` — zero occurrences in its 4680 lines — and
`group_names` only as an empty array (3e).

`custom_prompt_post_processing: 'strict'` dispatches at
`prompt-converters.js:96-97`:

```js
case PROMPT_PROCESSING_TYPE.STRICT:
    return mergeMessages(messages, names, { strict: true, placeholders: true, single: false, tools: false });
```

`mergeMessages` (`:823`) touches the names in exactly four places, every one of
them behind a truthiness guard (d7, verified):

```
:851  if (names.charName && !message.content.startsWith(`${names.charName}: `) && !names.startsWithGroupName(…))
:852        message.content = `${names.charName}: ${message.content}`;
:856  if (names.userName && !message.content.startsWith(`${names.userName}: `))
:857        message.content = `${names.userName}: ${message.content}`;
:870  as :851, on the other branch
:875  as :856, on the other branch
```

**Absent or empty short-circuits: the behaviour is "no name prefix", never "a
prefix with an empty name".**

Why this is not optional. Both proxy paths in the card send a **single user
message** (`[{ role: 'user', content: prompt }]`) because they want a JSON
planning object, not roleplay. With the name guards short-circuiting and the
`placeholders` half matching neither branch for a lone user message
(`:939-945` — 3e's reading, relayed, not independently verified), **strict
post-processing is an identity transform on this payload.**

Reproduce it as "prefix with an empty name" instead and every planning prompt
gains a leading `": "` while the model is being told to emit strict JSON. The
symptom would appear as the model failing to comply — three layers from the
cause, and the same shape as an unexpanded
`{{format_message_variable::…}}` reading as a model that will not follow a
format.

### 2.6 The model name is not an opaque string

Conditional parameters keyed on it (d7):

- `reasoning_effort` — CUSTOM/OPENAI when the model is in
  `OPENAI_REASONING_EFFORT_MODELS`, plus a `/^koboldcpp\/(.+)$/` special case
  (`:2500-2507`)
- `verbosity` — CUSTOM/OPENAI on `OPENAI_VERBOSITY_MODELS` (`:2509-2513`)
- OPENROUTER cache policy keyed on `/^anthropic\/claude/` and `/google\/gemini/`
  (`:2277-2278`)

**Normalising a model name changes routing behaviour.** A bridge that strips a
`koboldcpp/` prefix on the way through alters which branch upstream would have
taken.

### 2.7 CUSTOM's three escape valves

| field | effect | line |
| --- | --- | --- |
| `custom_include_body` | add arbitrary keys to the outbound **body** | `:2319` |
| `custom_include_headers` | add arbitrary outbound **headers** | `:2320`; `:1761` on `/status` |
| `custom_exclude_body` | delete keys from the outbound body | `:2573` |

All three parse YAML. These exist for providers that reject a parameter ST
sends.

These exist for providers that reject a parameter ST sends. The measured user
config uses `chat_completion_source: "custom"` with
`custom_url: https://api.deepseek.com`, so both valves are live for them.

---

## 3. The trust model: loopback-equals-trusted is *equivalent*, not looser

Recorded as a ruling, because it is the first evidence anyone should reach for
when the bridge's security is questioned.

Measured configuration on the operator's machine (`config.yaml`): `listen: false`,
`basicAuthMode: false`, `enableUserAccounts: false`,
`disableCsrfProtection: false`, `enableCorsProxy: false`.

Middleware order (`src/server-main.js`): Basic auth applies **only** with
`--listen` *and* `--basicAuthMode` (`:141-143`), so it is unreachable here. IP
and host allowlists, a session cookie (`:156-162`), the CSRF synchroniser token
(`:167-202`), and `requireLoginMiddleware` (`:248`) — which is three lines,
`if (!request.user) return response.sendStatus(403)` (`src/users.js:1027-1032`),
and passes unconditionally because `setUserDataMiddleware` always sets a default
user when accounts are disabled.

**So the effective authentication on these routes, in this configuration, is a
session cookie plus a CSRF token.** A CSRF token proves a request came from a
context that loaded this site; it does **not** establish who is asking. Upstream
in this configuration is trusting loopback and same-origin and nothing more.

Therefore treating loopback as trusted is **equivalent to upstream, not a
relaxation of it** — provided we likewise bind only to loopback. The layer that
would be missing on a non-loopback address is the one upstream supplies with
`--listen --basicAuthMode`, and adding that address without adding that layer is
where this equivalence stops holding.

---

## 4. Boundaries — measured to here and no further

- **The thirteen dedicated senders** (CLAUDE, AI21, MAKERSUITE, VERTEXAI,
  MISTRALAI, COHERE, DEEPSEEK, AIMLAPI, XAI, CHUTES, MINIMAX, ELECTRONHUB,
  AZURE_OPENAI) bypass the general path entirely and have their own request and
  response shapes. **Not measured.** The observed user is on CUSTOM, which takes
  the general path, so this is unmeasured rather than irrelevant — it becomes
  relevant the moment a card switches source.
- **`/bias` (`:2073`), `/multimodal-models` (`:2878`), `/process` (`:2880`)** —
  recorded as existing, not measured.
- **`postProcessPrompt`'s transformations** — confirmed to replace `messages` in
  place; the rules themselves not expanded.
- **`src/additional-headers.js`** reads `request.body` (`:219`: `api_type`,
  `secret_id`) but is **not on this path** — d7 searched `chat-completions.js`
  for `additional-headers`, `setAdditionalHeaders` and `getOverrideHeaders` and
  found no call. It serves text completion. Recorded so nobody checks twice.
- **One card path never uses the proxy at all.** `fetchPatch` (line 3985 of the
  sample's script, called at 4059) fetches directly without consulting the
  SillyTavern handle, sending `Authorization: Bearer <key>` to
  `normApiUrl(api.url)`. On failure it does not throw — it logs and returns
  `null`, retrying once with a correction appended. **A perfect proxy does not
  capture this call.** Whether to cover it is policy, not implementation.

---

## 4b. How to read a "not present" claim in this document

Both measurers nearly filed a false negative the same way, from opposite sides,
and the correction is worth stating as a rule.

3e found `group_names` with **zero hits** in `chat-completions.js` and was one
step from reporting it as the card author's mistake; widening to `src/` found the
consumer in `prompt-converters.js:53`. Following that lead, d7 recounted the
whole path's field set and found the injection valve — `custom_include_body` —
they had themselves missed, which had made an earlier version of §2.2 say the
outbound key set was closed when it is open.

**One grep of one file returning nothing is not evidence of absence.** Where this
document says a field can be ignored or a thing is not present, that claim is
only as wide as the search behind it — so the searches are named. A claim without
a stated scope should be re-measured before it is relied on.

The mirror error appeared too, and is worth the same warning. An earlier report
of §2.5c cited the name guards at `prompt-converters.js:405/410`; those lines are
inside `convertCohereMessages` (`:384`), one of the thirteen dedicated senders
that never runs on this path. Five more matches — `:207`, `:212`, `:254`,
`:259`, `:438` — belong to other converters. **A grep hit is not a call site**:
matching text says a name appears somewhere, not that the code containing it runs
here. Line numbers in this document have had their enclosing function read;
where one is relayed rather than verified, it says so.

## 5. Provenance

Supply side (SillyTavern source, line numbers relative to
`E:/sillyTavern/SillyTavern/`): d7. Consumer side (the sample card's 286 KiB
script, read in full): 3e. Both corrected their own earlier numbers in the course
of measuring — 3e's `parent.*` count was six and not sixteen, a local variable
named `parent` having been counted as `window.parent`; d7's outbound key set was
open rather than closed, `custom_include_body` having been missed. The counts
here are the corrected ones, and the corrections came from each other's leads
rather than from either measurer re-reading their own work.
