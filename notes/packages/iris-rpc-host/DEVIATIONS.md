# Deviations from SillyTavern

Where the transport deliberately does something other than what SillyTavern
does, and what each difference was measured to cost. A deviation with no
measurement is a guess, so every entry names the upstream source it read and
what would overturn it.

Upstream source cited here is the **installed** server, read-only:
`E:/sillyTavern/SillyTavern/src/`.

---

## 1. The `Host` header is an allow-list, always on, and a network bind refuses to start without one

**Kind.** Deliberate improvement (an ordinary loopback install is guarded with
no configuration), with one named compatibility gap (the static fallback).

Dated 2026-09-11.

### What was wrong

`packages/iris-rpc-host/src/events.ts:51-65` admitted a WebSocket upgrade when
`new URL(origin).host === host` — the request's `Origin` against the request's
own `Host`. Both headers are written by the browser from the URL the page was
served from, so the comparison asks nothing: any page, anywhere, sends a pair
that agrees with itself.

That is only a vulnerability because a loopback bind is not an access control.
`nip.io` and `sslip.io` are public wildcard DNS services that resolve any name
of the shape `127.0.0.1.nip.io` to `127.0.0.1`. So:

1. the victim visits `http://127.0.0.1.nip.io:8787` — an origin the attacker
   owns, resolving to the victim's own machine;
2. the browser connects to the Iris host on loopback and considers the page
   same-origin with it;
3. every cross-site defence stops applying, because nothing is cross-site any
   more: the JSON content-type preflight (`http.ts`) is not required, the
   absence of CORS headers blocks nothing, and
   `new WebSocket('ws://127.0.0.1.nip.io:8787/iris/events')` is admitted by the
   rule above.

The hub fans every frame out to every socket (`events.ts:127-144`), so the page
reads every `stream.text` and `stream.reasoning` delta of every conversation,
and can call every RPC method — `chat.*`, `character.*`, `worldbook.*`,
`connection.save`, `script.evalTemplate` — plus the avatar, script-bundle and
sandbox-asset GET routes. No interaction beyond visiting a page. Firefox and
Safari ship no Private Network Access check to fall back on.

**Measured before the change**, `packages/iris-rpc-host` booted on an ephemeral
port, raw sockets (`fetch` forbids setting `Host`, `ws` writes its own):

| request | `Host` | `Origin` | answer |
| --- | --- | --- | --- |
| `POST /iris/rpc` (`chat.list`) | `127.0.0.1.nip.io:<port>` | — | `200 OK`, handler ran |
| `GET /iris/events` upgrade | `127.0.0.1.nip.io:<port>` | `http://127.0.0.1.nip.io:<port>` | `101 Switching Protocols`, socket attached |
| `GET /iris/events` upgrade | two `Host` headers, the second rebinding | — | `101 Switching Protocols` |

**Measured after**: `403`, `403`, `403`; the handler did not run, and a
follow-up `chat.list` under the real host shows the refused `chat.create`
created nothing (`apps/iris/tests/host-allowlist.test.ts`).

### What upstream does

SillyTavern has the same problem and the same instrument, reached from the
other end. `src/middleware/hostWhitelist.js` exists and its docblock says why:
「Middleware to validate remote hosts. Useful to protect against DNS rebinding
attacks.」 It delegates to the `host-validation-middleware` package
(`node_modules/host-validation-middleware/dist/index.js`), and
`src/server-main.js:150` mounts it with `app.use` before the session, the CSRF
protection and the static file server at line 242 — so upstream covers
*everything it serves*, this repository's static fallback included in spirit.

Three things about it, read rather than assumed:

| upstream | reading |
| --- | --- |
| **off by default** | `default/config.yaml:142-152` — `hostWhitelist.enabled: false`, `hosts: []`. `hostWhitelist.js:39-41` returns `next()` when disabled, so the shipped default validates nothing |
| **scan mode warns instead** | `hostWhitelist.js:26-38` — with `scan: true` (the default) it prints 「Request from untrusted host」 once per distinct value, bounded at `maxKnownHosts = 1000` |
| **the port is not part of the rule** | `extractHostNameFromHostHeader` strips `:port`; any IPv4 or IPv6 **literal** host returns `true` outright, and `localhost` / `*.localhost` are always allowed. Entries match the hostname exactly, or as a suffix when written with a leading dot (`.trycloudflare.com`) |

Around it sit defences Iris has no equivalent of: `whitelist.js` (an allow-list
on the *client IP*, on by default and limited to loopback), `basicAuth.js`, and
a CSRF token (`server-main.js:168-202`). Upstream is a full server with user
accounts; Iris is a single-user host bound to loopback, and has never claimed
otherwise.

### What Iris does

One module, `packages/iris-rpc-host/src/host-guard.ts`, holding the rule and the
derivation of the set it compares against. The set is:

- `{127.0.0.1, localhost, [::1]}` each paired with the **bound** port — read
  from `ctx.webServer.port` at request time, because `port: 0` (every test here)
  and an already-taken configured port both make the configured and the actual
  port different numbers; plus the bare names when the bound port is 80, which
  is the one port a browser omits from `Host`;
- ∪ configured `allowedHosts` (new rpc-host config; `IRIS_ALLOWED_HOSTS`,
  comma-separated, in `apps/iris/cordis.yml`);
- ∪ the hosts of `allowedOrigins`, so a dev server that proxies without
  rewriting `Host` still reaches the transport.

Comparison is **exact and case-insensitive after trimming**. No suffix rule, no
wildcard, no parse of the header into hostname and port — `[::1]:8787` keeps its
brackets and is one string. A `Host` that is absent, empty, whitespace, or
**repeated** is refused; the values are read from `req.rawHeaders`, not
`req.headers.host`, because the parsed view keeps only the first of a repeated
header and that is exactly the disagreement a smuggled request is built on.

Applied to every answer Iris owns: the RPC POST (first, before the method and
the content type), the event upgrade (before any `Origin` logic), and the four
routes `@iris/app-service` registers on the same carrier — avatars, `/version`,
the script bundle, the sandbox assets — each wrapped at its registration with
`ctx.irisRpc.guard(...)`. A refusal is `403` with a one-line `text/plain` body
naming the rule and not echoing the offending value; an upgrade is refused with
`403` and the socket destroyed before the handshake completes. The logger warns
once per distinct offending value, capped at 32 distinct values
(`RefusalLog`) — the same shape as upstream's `knownHosts` bound, three decimal
orders smaller because this host is single-user.

The `Origin` check on the upgrade becomes a literal allow-list too:
`{http://, https://} ×` the host set, ∪ `allowedOrigins`. An absent `Origin`
stays accepted, because browsers always send one on an upgrade and its absence
means a non-browser client — but only *after* the `Host` guard, so it is no
longer a way in. An `Origin` that is present and not in the set is refused,
`null` and unparsable values included, with no branch of their own: the set is
literal.

**A non-loopback bind refuses to start.** If the carrier's bind host is not
loopback and `allowedHosts` is empty, `[Service.init]` throws before either
route is registered, with one sentence naming the config to set and why (a
reverse proxy in front arrives under its own public host, which this process
cannot derive). This is deliberately stronger than the "print a warning"
upstream chose: a warning in a scrolling log is read after the incident, and the
only deployment it would inconvenience is one that has to be configured anyway.

### What it costs

1. **The static fallback is not guarded.** `dsh-host-webserver`'s fallback seat
   belongs to `@deepseek-ai/dsh-host-frontend-static`, an external package with
   no header hook, so `index.html` and the built assets answer any `Host`.
   Upstream guards its static serve (`server-main.js:150` precedes `:242`). The
   gap is bounded: those bytes are the same for every user and contain no
   profile data, and a rebound page can already fetch the same files from the
   attacker's own server. What it costs is that the *page* still loads at
   `http://127.0.0.1.nip.io:8787` — and then every call it makes is refused, so
   what the attacker gets is a broken copy of the interface. Closing it needs a
   hook in the carrier or the frontend package, not a change here.
2. **A deployment behind a reverse proxy must be configured.** Upstream's
   default starts and warns; Iris's refuses to start. The error names the
   variable, so the cost is one line of configuration, once.
3. **Port 80 is coarser than the rest.** Bound there, the bare names are in the
   set because a browser omits the default port, so `Host: localhost` is
   accepted — as it is upstream, unconditionally, on every port.
4. **A per-request derivation.** Six strings and two sets are built per request
   rather than cached, so that the bound port cannot go stale. Beside a file
   read or a model call it is not measurable, and the alternative is a cache
   that has to notice a port change it has no event for.

### What would overturn it

- A carrier that exposes a header hook for the fallback seat, or a frontend
  package that takes one: cost (1) closes, and the guard covers everything this
  process answers.
- A measurement showing a legitimate deployment this rule refuses — the shape
  to look for is a client that sends a `Host` the host cannot derive and that
  is awkward to configure (a container's own name, an IPv6 zone id). The answer
  would be an `allowedHosts` entry, not a wildcard.
- Chrome and Firefox both shipping Private Network Access, enforced, for
  loopback: that would make the browser refuse the rebound request before it
  arrives, and this guard would become defence in depth rather than the
  defence. It is not the state today, and Safari has announced nothing.

### Where it is pinned

- `packages/iris-rpc-host/tests/host-guard.test.ts` — the rule itself: the
  derivation from the bound port, `127.0.0.1.nip.io:8787` and its neighbours
  refused, absent / empty / repeated refused, case and whitespace, the
  `allowedHosts` and `allowedOrigins` contributions, the bind check, the log
  cap.
- `packages/iris-rpc-host/tests/transport.test.ts` — through a real socket: the
  rebinding POST (403, no side effect) and upgrade (403, with and without an
  `Origin`), a configured `allowedHosts` entry answered and its neighbours not,
  and — with a stand-in carrier claiming `0.0.0.0` — the composition failing
  before it mounts a route, and starting when the hosts are named.
- `apps/iris/tests/host-allowlist.test.ts` — a booted composition on `port: 0`:
  the exploit end to end, the four application routes refusing a foreign `Host`
  and answering the real one, the dev origin still connecting, and the sandbox
  asset still served with its CORS header.
