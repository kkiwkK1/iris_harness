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
| `405` | not a POST |
| `415` | missing or wrong `content-type` |
| `413` | body past `maxBodyBytes` |
| `400` | unparsable JSON, or a frame with no id |

A malformed frame from one page never disconnects another. That is the point of
answering rather than tearing down.

## Why `content-type: application/json` is mandatory

`dsh-host-webserver` ships no TLS and no authentication — its own README says
so — and Iris binds to loopback and trusts the machine. What that still leaves
exposed is a page on an unrelated origin firing requests at the port. A POST
carrying `application/json` is **not** a CORS simple request, so the browser must
preflight it, and no `access-control-allow-origin` is ever sent. Requiring that
content type is what stops a hostile page blind-firing a method with side
effects. `text/plain`, `multipart/form-data` and form encodings are refused.

WebSockets are exempt from the same-origin policy, so the header above protects
nothing on the event stream — a page on any origin could otherwise open one and
read conversation text. The upgrade therefore checks `Origin` itself: absent is
allowed (browsers always send one, so its absence means a non-browser client),
same-host is allowed, and anything else must be listed in `allowedOrigins`.

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
exist on the host at all. Failing that, set `IRIS_DEV_ORIGIN=http://localhost:5173`,
which only widens the WebSocket origin check.

## Known limits

- No TLS, no authentication. Loopback only. Putting Iris on a network needs a
  reverse proxy in front — not `host: '0.0.0.0'` here.
- `character.import` carries the card as base64 inside the JSON frame, so a 4 MB
  PNG becomes roughly 5.5 MB of body against a 1 MB `maxBodyBytes` default.
  Raise the cap in the composition, or add a dedicated upload route.
- A page that falls more than 8 MB behind on the event stream is dropped rather
  than buffered for. It reconnects and re-opens the chat, which resyncs from
  host truth.
