# @iris/rpc-host

The host end of the Iris wire, as a Cordis plugin over `ctx.webServer`. The
browser end is [`@iris/rpc-client`](../iris-rpc-client); the shapes both sides
agree on are frozen in [`@iris/protocol`](../iris-protocol). This file documents
the seam between them, because it is the one thing neither package can state on
its own.

## The two endpoints

| | |
| --- | --- |
| `POST /iris/rpc` | one request frame in, one response frame out |
| `WS /iris/events` | `IrisEvent` frames, host → browser |
| `GET /iris/avatar/<characterId>` | card pictures, registered by `@iris/app-service` |

All three are configurable; the defaults are what the composition ships.

**Generation is not a response.** `chat.send` resolves as soon as the turn is
open and returns `{ turn }`; the reply arrives as `stream.text` /
`stream.reasoning` / `stream.end` on the socket. A call that resolved with the
finished text could neither be streamed nor interrupted.

## HTTP status vs. the frame

Status describes the transport; the frame describes the call. Anything that can
be correlated to a request id answers **`200` with a `RpcResponseFrame`** —
refusals included — so a client has exactly one code path: parse the frame, look
at `ok`. A non-2xx means no frame could be built at all:

| | |
| --- | --- |
| `403` | a `Host` this process does not answer to |
| `405` | not a POST |
| `415` | missing or wrong `content-type` |
| `413` | body past `maxBodyBytes` |
| `400` | unparsable JSON, or a frame with no id |

A malformed frame from one page never disconnects another. That is the point of
answering rather than tearing down.

## The `Host` allow-list

**A loopback bind is a bind, not a door.** `nip.io` and `sslip.io` are public
wildcard DNS services that resolve any name of the shape `127.0.0.1.nip.io` to
loopback, so an attacker can serve a page from `http://127.0.0.1.nip.io:8787` —
an origin they own — and the browser will treat it as same-origin with the Iris
host on the victim's machine. Nothing below survives that: the content-type gate
is a *cross-site* defence, and after the rebind nothing is cross-site.

So every request this process answers is checked against a small literal set of
`Host` values, first, before anything else about it is looked at:

- `127.0.0.1`, `localhost` and `[::1]`, each with the **bound** port (the one
  the carrier settled on, which `port: 0` and a taken port both make different
  from the configured one);
- plus `allowedHosts` — exact `host:port` strings, `IRIS_ALLOWED_HOSTS` in the
  shipped composition;
- plus the hosts of `allowedOrigins`.

Exact, case-insensitive, trimmed. No wildcard and no suffix rule: `.nip.io` is
what a suffix rule loses to. Absent, empty, unparsable and **repeated** `Host`
headers are all refused, and the values are read from `rawHeaders`, because the
parsed view keeps only the first of a repeat. A refusal is `403` with a one-line
body naming the rule, and the logger says so once per distinct offending value.

The check covers this package's two endpoints and every route
`@iris/app-service` registers on the same carrier, through
`ctx.irisRpc.guard(handler)`. It does **not** cover the carrier's static
fallback, which belongs to the frontend package and has no header hook — the
known gap, recorded with its cost in
[`notes/packages/iris-rpc-host/DEVIATIONS.md`](../../notes/packages/iris-rpc-host/DEVIATIONS.md) §1.

**A non-loopback bind refuses to start** unless `allowedHosts` is set, naming
the variable in the error: a reverse proxy in front arrives under its own public
host, and this process cannot guess it.

## Why `content-type: application/json` is mandatory

`dsh-host-webserver` ships no TLS and no authentication — its own README says
so — and Iris binds to loopback and trusts the machine. What the allow-list
above does not cover is a page on an **unrelated** origin firing requests at the
port. A POST carrying `application/json` is **not** a CORS simple request, so the
browser must preflight it, and no `access-control-allow-origin` is ever sent.
Requiring that content type is what stops a hostile page blind-firing a method
with side effects. `text/plain`, `multipart/form-data` and form encodings are
refused.

WebSockets are exempt from the same-origin policy, so the header above protects
nothing on the event stream — a page on any origin could otherwise open one and
read conversation text. The upgrade therefore checks `Origin` against a literal
allow-list of its own: `{http://, https://}` × the host set above, plus anything
in `allowedOrigins`. Absent is allowed (browsers always send one on an upgrade,
so its absence means a non-browser client) — but only after the `Host` check,
which every client has to pass.

## Wiring a browser

```ts
import { IrisHttpClient } from '@iris/rpc-client'

const client = new IrisHttpClient()        // same-origin; connects immediately
const stop = client.subscribe(event => { /* IrisEvent */ })
const { view } = await client.call('chat.open', { chatId })
```

- `subscribe()` returns a disposer. Iris is plugin-based; every registration is
  reversible.
- `call()` rejects with `IrisRpcError`, which is an `Error` *and* structurally an
  `RpcError`, so `catch (error) { error.code }` works.
- `connected` reflects the socket, not the intent to connect. It is a plain
  readonly boolean in the protocol, so the concrete client also offers
  `onConnectionChange(listener) => disposer` — use it rather than polling.
- Reconnect is automatic, with jittered exponential backoff.

### Views arrive finished

`ChatView.messages[].text` has already had the chat's display-direction regex
scripts applied by the host. **Do not run them again in the browser**: a card's
scripts would then exist in two engines that can disagree.

A turn in flight shows up as a trailing `MessageView` with `streaming: true`
carrying the text so far, so a page that opens or reloads mid-generation sees
real state rather than a gap.

`MessageView.id` is the message's index in the SillyTavern projection of the
chat — the same number `chat.editMessage` and `chat.deleteMessage` address, and
the same one a card script sees. **Render with `key`, not `id`**: `id` is a
position, so a delete shifts every later one. `key` is minted by the host and
carried across the log rebuild that a delete performs, and a streaming row keeps
the key it settles into, so a reply has one identity from its first token
onward.

`settings.set` distinguishes three cases: an omitted key leaves the field alone,
an explicit `null` removes the override so the layer below shows through (that
is what a "use host default" control sends), and an unknown key is dropped.
Clearing on the global layer restores what the composition configured, since
nothing sits below it.

`stream.error.code` is free-form, unlike `RpcError['code']`. The host emits
`'aborted'` for a turn the user stopped and `'provider-error'` for a real
failure; a UI wants to tell those apart.

### Development

Serve the page from the host's own origin. The shipped composition already does
this with a static row, so nothing is cross-origin.

If you run a separate dev server anyway, **proxy `/iris/rpc`, `/iris/events` and
`/iris/avatar` to the host** rather than pointing the client at another origin.
That keeps the browser same-origin and means no cross-origin exception has to
exist on the host at all. Rewrite `Host` while proxying (Vite's `changeOrigin`),
or the allow-list refuses the request before anything else looks at it; for the
event socket, rewrite `Origin` too (`rewriteWsOrigin`). Failing that, set
`IRIS_DEV_ORIGIN=http://localhost:5173`, which widens both lists — the WebSocket
origin check and, with it, the `Host` the dev server arrives under.

## Known limits

- No TLS, no authentication. Loopback only. Putting Iris on a network needs a
  reverse proxy in front — not `host: '0.0.0.0'` here, which now refuses to
  start until `allowedHosts` names the hosts that proxy answers to.
- The carrier's static fallback (the built interface) is served by another
  package and is **not** behind the `Host` allow-list. Those bytes are the same
  for every user and carry no profile data, but the page does still load under a
  rebound name — with every call it makes refused.
- `character.import` carries the card as base64 inside the JSON frame, so a 4 MB
  PNG becomes roughly 5.5 MB of body against a 1 MB `maxBodyBytes` default.
  Raise the cap in the composition, or add a dedicated upload route.
- A page that falls more than 8 MB behind on the event stream is dropped rather
  than buffered for. It reconnects and re-opens the chat, which resyncs from
  host truth.
