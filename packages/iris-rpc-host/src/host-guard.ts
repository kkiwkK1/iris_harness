/**
 * Who this host answers to: the `Host` header allow-list.
 *
 * A loopback bind is not an access control. Public wildcard DNS — `nip.io`,
 * `sslip.io` and friends — resolves any name of the shape
 * `127.0.0.1.nip.io` to loopback, so a page served from
 * `http://127.0.0.1.nip.io:8787` is a *browser origin the attacker controls*
 * that talks to this process over the socket it bound to itself. Nothing about
 * the connection is unusual: the TCP peer is 127.0.0.1, the request is
 * well-formed, and after the browser's DNS entry flips to loopback the page is
 * same-origin with the host, so every cross-site defence the platform offers
 * (the JSON content-type preflight, the absence of CORS headers, cookies) is
 * simply not in the path any more. Firefox and Safari ship no Private Network
 * Access check to fall back on.
 *
 * The one thing the attacker's page **cannot** change is the `Host` header: the
 * browser writes it from the URL's authority, and that authority is the
 * attacker's name — never `127.0.0.1:8787`. So the header is the discriminator,
 * and this module is the single place that reads it.
 *
 * The rule is deliberately dull: an **exact, case-insensitive match** of the
 * trimmed header against a small literal set. No suffix matching (`.nip.io`
 * defeats suffixes by construction), no wildcards, no parsing of the header
 * into parts (a parser is a second place for the two sides to disagree, which
 * is the shape every Host-header bypass has). Everything not in the set is
 * refused, which makes "absent", "empty", "duplicated" and "not a host at all"
 * one case rather than four.
 *
 * The `Origin` allow-list for the event socket is derived from the same set,
 * for the same reason: the previous rule — accept an `Origin` whose host equals
 * the `Host` header — was self-referential, since a page at
 * `http://127.0.0.1.nip.io:8787` sends exactly that pair.
 *
 * @module @iris/rpc-host/host-guard
 */

import type { IncomingMessage } from 'node:http'

/**
 * The names a browser on this machine can put in a URL to reach a loopback bind.
 *
 * `[::1]` keeps its brackets: that is how it appears in a URL authority and
 * therefore how it arrives in `Host`, and stripping them would be the first
 * step of a parser this module deliberately does not have.
 */
export const LOOPBACK_HOSTNAMES: readonly string[] = ['127.0.0.1', 'localhost', '[::1]']

/**
 * Bind addresses that are unreachable from anywhere but this machine.
 *
 * `dsh-host-webserver`'s schema admits only `127.0.0.1` and `0.0.0.0`, so today
 * exactly one value outside this set can be configured; the set is written for
 * the address rather than for that schema because the guard must stay right if
 * the carrier ever grows `::` or a LAN address.
 */
const LOOPBACK_BINDS: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

/**
 * The port a browser omits from `Host`.
 *
 * The carrier speaks plain HTTP, so 80 is the only default in play: bound
 * there, a legitimate page sends `Host: 127.0.0.1` with no port at all, and a
 * set built only from `host:port` strings would refuse the whole product.
 */
const HTTP_DEFAULT_PORT = 80

/** How many distinct refused `Host` values are worth a log line. */
export const MAX_REPORTED_HOSTS = 32

/** What the allow-set is derived from. */
export interface AllowanceInput {
  /** The port the carrier actually bound — not the configured one. */
  port: number
  /** Exact `host:port` values this deployment answers to, from config. */
  allowedHosts: readonly string[]
  /** Origins opted into for the event socket, e.g. a front-end dev server. */
  allowedOrigins: readonly string[]
}

/** The two literal sets one request is checked against. */
export interface HostAllowance {
  /** Allowed `Host` header values, normalized. */
  hosts: ReadonlySet<string>
  /** Allowed `Origin` header values, normalized. */
  origins: ReadonlySet<string>
}

/**
 * The one normalization both sides of every comparison go through.
 *
 * Trim and lower-case, and nothing else. Host names are case-insensitive and a
 * header value may carry surrounding whitespace; everything further — dropping
 * a trailing dot, unbracketing IPv6, defaulting a port — would be a parser, and
 * a parser is where the set and the header stop meaning the same thing.
 * @param value - a raw header value or a configured entry.
 * @returns the comparable form.
 */
function normalize(value: string): string {
  return value.trim().toLowerCase()
}

/**
 * Build the allow-set for one moment.
 *
 * Called per request rather than per construction, because the bound port is
 * not known until the carrier has listened and `port: 0` (the tests) or a
 * taken port (a second host on the same machine) make the configured and the
 * actual port different numbers.
 * @param input - the bound port and the configured extras.
 * @returns the host and origin sets.
 */
export function deriveAllowance(input: AllowanceInput): HostAllowance {
  const hosts = new Set<string>()
  const suffix = `:${String(input.port)}`
  for (const name of LOOPBACK_HOSTNAMES) {
    hosts.add(name + suffix)
    if (input.port === HTTP_DEFAULT_PORT) hosts.add(name)
  }
  for (const entry of input.allowedHosts) {
    const value = normalize(entry)
    if (value !== '') hosts.add(value)
  }
  // An opted-into origin's own authority answers as a `Host` too: a dev server
  // that proxies these two paths without rewriting `Host` arrives under its own
  // name, and refusing it there would make the option do nothing.
  for (const entry of input.allowedOrigins) {
    const value = normalize(entry)
    if (value === '') continue
    try {
      const host = new URL(value).host
      if (host !== '') hosts.add(host)
    } catch {
      // Not a URL. It can still match an `Origin` literally below; it just
      // contributes no host.
    }
  }

  const origins = new Set<string>()
  for (const host of hosts) {
    origins.add(`http://${host}`)
    origins.add(`https://${host}`)
  }
  for (const entry of input.allowedOrigins) {
    const value = normalize(entry)
    if (value !== '') origins.add(value)
  }
  return { hosts, origins }
}

/**
 * Every `Host` header on one request, in the order they arrived.
 *
 * Read from `rawHeaders` rather than `headers.host`, because the parsed view
 * keeps only the first of a repeated `Host` and a request carrying two is
 * precisely the shape a request smuggler builds: the value this guard checks
 * and the value something downstream reads would be different strings.
 * @param req - the incoming request or upgrade.
 * @returns the values, empty when the header is absent.
 */
export function hostHeadersOf(req: IncomingMessage): string[] {
  const found: string[] = []
  const raw = req.rawHeaders
  for (let at = 0; at + 1 < raw.length; at += 2) {
    if (raw[at]?.toLowerCase() === 'host') found.push(raw[at + 1] ?? '')
  }
  return found
}

/**
 * Whether a request's `Host` is one this host answers to.
 *
 * @param headers - every `Host` value on the request; none, one, or several.
 * @param allowed - the allowed set from {@link deriveAllowance}.
 * @returns true when the request may be answered.
 */
export function isHostAllowed(headers: readonly string[], allowed: ReadonlySet<string>): boolean {
  // Absent or repeated: no browser sends either to a server it means to talk
  // to, and one value is what "the" Host header has to mean for this check to
  // be a check at all.
  if (headers.length !== 1) return false
  const value = normalize(headers[0] ?? '')
  if (value === '') return false
  return allowed.has(value)
}

/**
 * Whether an upgrade's `Origin` may open the event socket.
 *
 * A WebSocket is exempt from the same-origin policy, so this is the only thing
 * standing between a page's `new WebSocket` and every token of every
 * conversation. `undefined` is allowed because browsers always send an
 * `Origin` on an upgrade: its absence means a non-browser client, which has
 * already had to satisfy the `Host` guard to get here. Anything present and
 * not in the set is refused — including `null` (an opaque origin) and any
 * value that is not a URL at all, which need no separate branch because the
 * set is literal.
 * @param origin - the `Origin` header, absent for non-browser clients.
 * @param allowed - the allowed set from {@link deriveAllowance}.
 * @returns true when the upgrade may proceed.
 */
export function isOriginAllowed(origin: string | undefined, allowed: ReadonlySet<string>): boolean {
  if (origin === undefined) return true
  return allowed.has(normalize(origin))
}

/**
 * Whether a bind address is reachable only from this machine.
 * @param bindHost - the carrier's configured listen address.
 * @returns true for loopback.
 */
export function isLoopbackBind(bindHost: string): boolean {
  return LOOPBACK_BINDS.has(normalize(bindHost))
}

/**
 * Why a composition must not start, when a network bind carries no allow-list.
 *
 * A loopback bind derives a working set on its own, so the common case needs no
 * configuration. A network bind cannot: the `Host` every legitimate page sends
 * is then the machine's own name or the public name of a reverse proxy, neither
 * of which this process can know, and guessing would either refuse every real
 * request or accept every rebound one. Refusing to start is the honest answer —
 * a warning printed into a scrolling log is read after the incident.
 * @param bindHost - the carrier's configured listen address.
 * @param allowedHosts - the configured `host:port` allow-list.
 * @returns the sentence to fail with, or `undefined` when the bind is fine.
 */
export function describeUnconfiguredBind(
  bindHost: string,
  allowedHosts: readonly string[],
): string | undefined {
  if (isLoopbackBind(bindHost)) return undefined
  if (allowedHosts.some(entry => normalize(entry) !== '')) return undefined
  return `iris-rpc-host: refusing to start because the web server is bound to ${bindHost}, which is `
    + 'reachable from the network, while `allowedHosts` is empty — set it (IRIS_ALLOWED_HOSTS in '
    + '`apps/iris/cordis.yml`) to the exact `host:port` every legitimate page uses, including the '
    + 'public host of any reverse proxy in front, because the Host header is the only thing that '
    + 'tells a real request from a page that pointed its own DNS name at this machine.'
}

/**
 * One log line per distinct offending value, and no more than a few dozen.
 *
 * A refusal is worth saying once: it is either a misconfiguration the operator
 * has to fix or an attempt the operator should know about. It is not worth
 * saying per request — a scan sends thousands, and a log a scan can fill is a
 * log nobody reads and a disk somebody fills. The cap is on *distinct* values,
 * so the ordinary case (one wrong host, repeated) prints once and the hostile
 * case (a fresh name every request) stops after {@link MAX_REPORTED_HOSTS}.
 */
export class RefusalLog {
  readonly #seen = new Set<string>()
  readonly #cap: number
  #capped = false

  /**
   * @param cap - how many distinct values to report before going quiet.
   */
  constructor(cap: number = MAX_REPORTED_HOSTS) {
    this.#cap = cap
  }

  /** How many distinct values have been reported. */
  get reported(): number {
    return this.#seen.size
  }

  /**
   * Record one refusal and say whether it is worth a log line.
   * @param value - the offending header value, as it arrived.
   * @returns true the first time each distinct value is seen, until the cap.
   */
  shouldReport(value: string): boolean {
    if (this.#seen.has(value)) return false
    if (this.#seen.size >= this.#cap) {
      // Said once, so the silence afterwards is itself in the record.
      const first = !this.#capped
      this.#capped = true
      return first
    }
    this.#seen.add(value)
    return true
  }

  /** Whether the cap has been reached, i.e. later refusals go unreported. */
  get capped(): boolean {
    return this.#capped
  }
}
