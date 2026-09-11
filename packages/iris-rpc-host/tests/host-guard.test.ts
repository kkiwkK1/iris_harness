import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  MAX_REPORTED_HOSTS,
  RefusalLog,
  deriveAllowance,
  describeUnconfiguredBind,
  hostHeadersOf,
  isHostAllowed,
  isLoopbackBind,
} from '../src/index.ts'

/**
 * The `Host` allow-list, at the level where its rule is one expression.
 *
 * The transport test next door asks the same questions through a socket, and
 * that is the one that proves the guard is *mounted*. This file is where the
 * rule itself is written down, because the interesting cases are the ones a
 * socket makes awkward to produce: a repeated header, a header that is not a
 * host at all, a bound port that is not the configured one.
 *
 * The case that matters most is one line in a table:
 * `127.0.0.1.nip.io:8787` is refused. It is a real, resolvable, public DNS
 * name that answers `127.0.0.1` — `nip.io` and `sslip.io` both do this for any
 * address you spell into the label — so a page served from it is a browser
 * origin an attacker owns that reaches this process over its own loopback bind.
 * Every guard that reasoned from "the connection came from loopback" or "the
 * Origin agrees with the Host" is blind to it by construction.
 *
 * @module @iris/rpc-host/tests/host-guard
 */

/** The set a host bound to 8787 with no configuration derives for itself. */
function loopbackAllowance(port = 8787): ReturnType<typeof deriveAllowance> {
  return deriveAllowance({ port, allowedHosts: [], allowedOrigins: [] })
}

/** Ask the predicate about one raw header value. */
function allows(value: string, allowed: ReadonlySet<string>): boolean {
  return isHostAllowed([value], allowed)
}

test('a loopback bind derives every name a page on this machine can use, and only on the bound port', () => {
  const { hosts } = loopbackAllowance()

  assert.deepEqual([...hosts].sort(), ['127.0.0.1:8787', '[::1]:8787', 'localhost:8787'])

  for (const value of ['127.0.0.1:8787', 'localhost:8787', '[::1]:8787']) {
    assert.equal(allows(value, hosts), true, `${value} is this host`)
  }

  // The bracketed IPv6 literal keeps its brackets, because that is the form a
  // URL authority has and therefore the form `Host` arrives in. Unbracketing it
  // would be the first line of a parser this guard deliberately does not have.
  assert.equal(allows('::1:8787', hosts), false, 'an unbracketed IPv6 host is not the same string')
})

test('the port in the set is the port that was actually bound', () => {
  /*
   * Not a detail. `port: 0` (every test in this repository) and an already-taken
   * configured port (a second host on the same machine, which is this project's
   * parallel-work convention) both make the configured number and the listening
   * number different, and a guard built from the configured one would refuse
   * every request the running host actually receives — or, worse, admit the
   * port some *other* process is serving on.
   */
  const { hosts } = loopbackAllowance(8787)
  assert.equal(allows('127.0.0.1:8787', hosts), true)
  assert.equal(allows('127.0.0.1:8788', hosts), false, 'a neighbouring host on 8788 is not this host')
  assert.equal(allows('127.0.0.1', hosts), false, 'a bare host names port 80, which is not this bind')

  // Bound on 80, a browser omits the port entirely, so the bare name has to be
  // in the set or the product refuses itself.
  const eighty = loopbackAllowance(80).hosts
  assert.equal(allows('127.0.0.1', eighty), true)
  assert.equal(allows('127.0.0.1:80', eighty), true)
})

test('the rebinding names public wildcard DNS hands out are refused', () => {
  const { hosts } = loopbackAllowance()
  const rebinding = [
    // The exploit, verbatim: a page here resolves to loopback and sends this.
    '127.0.0.1.nip.io:8787',
    '127.0.0.1.sslip.io:8787',
    'app.127.0.0.1.nip.io:8787',
    // A suffix rule (`endsWith('127.0.0.1')`) would take this one.
    'evil.com.127.0.0.1:8787',
    // And a prefix rule would take this one. Both are why the match is exact.
    '127.0.0.1.evil.com:8787',
    'evil.com:8787',
    'localhost.evil.com:8787',
  ]
  for (const value of rebinding) {
    assert.equal(allows(value, hosts), false, `${value} must not be treated as this host`)
  }
})

test('a Host that is absent, empty, or repeated is refused', () => {
  const { hosts } = loopbackAllowance()

  assert.equal(isHostAllowed([], hosts), false, 'no Host header at all')
  assert.equal(isHostAllowed([''], hosts), false, 'an empty Host header')
  assert.equal(isHostAllowed(['   '], hosts), false, 'a whitespace Host header')

  /*
   * Two `Host` headers is the smuggling shape: whichever one this guard read,
   * something downstream could read the other. There is no reading of "the"
   * Host header for such a request, so there is nothing to allow — including
   * the case where the *first* one is legitimate.
   */
  assert.equal(isHostAllowed(['127.0.0.1:8787', '127.0.0.1.nip.io:8787'], hosts), false)
  assert.equal(isHostAllowed(['127.0.0.1:8787', '127.0.0.1:8787'], hosts), false)
})

test('comparison is case-insensitive and tolerates surrounding whitespace', () => {
  const { hosts } = loopbackAllowance()
  assert.equal(allows('LOCALHOST:8787', hosts), true)
  assert.equal(allows(' localhost:8787 ', hosts), true)
  assert.equal(allows('Localhost:8787', hosts), true)
  // Inner whitespace is not trimmed away into a match; the value is one string.
  assert.equal(allows('localhost :8787', hosts), false)
})

test('configured allowedHosts are exact strings, and they carry their own origins', () => {
  const { hosts, origins } = deriveAllowance({
    port: 8787,
    allowedHosts: ['iris.example.com', '  IRIS.EXAMPLE.COM:8443  ', ''],
    allowedOrigins: [],
  })

  assert.equal(allows('iris.example.com', hosts), true)
  assert.equal(allows('iris.example.com:8443', hosts), true, 'normalized to lower case and trimmed')
  assert.equal(allows('iris.example.com:9999', hosts), false, 'a different port is a different entry')
  assert.equal(allows('sub.iris.example.com', hosts), false, 'no wildcard, ever')
  assert.equal(hosts.has(''), false, 'an empty entry (a trailing comma in the env var) adds nothing')

  assert.equal(origins.has('https://iris.example.com'), true)
  assert.equal(origins.has('http://iris.example.com'), true)
})

test('an opted-into origin also answers as a Host, so a plain proxy still works', () => {
  const { hosts, origins } = deriveAllowance({
    port: 8787,
    allowedHosts: [],
    allowedOrigins: ['http://localhost:5173', 'not-a-url'],
  })

  assert.equal(origins.has('http://localhost:5173'), true)
  assert.equal(allows('localhost:5173', hosts), true, 'a dev server that proxies without rewriting Host')
  // An entry that is not a URL contributes no host but is still matched
  // literally as an origin, which is the only thing it could have meant.
  assert.equal(origins.has('not-a-url'), true)
  assert.equal(hosts.has('not-a-url'), false)
})

test('the Host headers are read from the raw list, not the parsed one', () => {
  /*
   * `req.headers.host` keeps only the first of a repeated `Host`. Reading the
   * raw list is what makes the duplicate case *visible* to the predicate above
   * — through the parsed view, a request carrying two would arrive looking like
   * a request carrying one legitimate value.
   */
  const req = {
    rawHeaders: ['Content-Type', 'application/json', 'HOST', '127.0.0.1:8787', 'host', 'evil.example'],
  } as never
  assert.deepEqual(hostHeadersOf(req), ['127.0.0.1:8787', 'evil.example'])

  assert.deepEqual(hostHeadersOf({ rawHeaders: ['accept', '*/*'] } as never), [])
})

test('loopback binds are recognised, and a network bind with no allow-list refuses to start', () => {
  assert.equal(isLoopbackBind('127.0.0.1'), true)
  assert.equal(isLoopbackBind('::1'), true)
  assert.equal(isLoopbackBind('localhost'), true)
  assert.equal(isLoopbackBind('0.0.0.0'), false)
  assert.equal(isLoopbackBind('192.168.1.10'), false)

  assert.equal(describeUnconfiguredBind('127.0.0.1', []), undefined, 'the product composition needs no config')

  const refusal = describeUnconfiguredBind('0.0.0.0', [])
  assert.ok(refusal !== undefined, 'a network bind with no allowedHosts must not start')
  assert.match(refusal, /0\.0\.0\.0/, 'the sentence names the bind that caused it')
  assert.match(refusal, /allowedHosts/, 'and the config to set')
  assert.match(refusal, /IRIS_ALLOWED_HOSTS/, 'and how to set it from the product composition')
  assert.match(refusal, /reverse proxy/, 'and why a proxied deployment has to be listed')

  assert.equal(
    describeUnconfiguredBind('0.0.0.0', ['iris.example.com']),
    undefined,
    'a network bind that names its hosts is a configured deployment, not a mistake',
  )
  assert.ok(
    describeUnconfiguredBind('0.0.0.0', ['', '  ']) !== undefined,
    'entries that normalize to nothing are not an allow-list',
  )
})

test('a refusal is logged once per distinct value, and a scan cannot flood the log', () => {
  const log = new RefusalLog(3)

  assert.equal(log.shouldReport('evil.example'), true)
  assert.equal(log.shouldReport('evil.example'), false, 'the same offender is not worth a second line')
  assert.equal(log.shouldReport('other.example'), true)
  assert.equal(log.shouldReport('third.example'), true)
  assert.equal(log.reported, 3)

  // Past the cap: one line saying so, then silence. A scanner sending a fresh
  // name per request is the case this exists for — a log it can fill is a log
  // nobody reads and a disk somebody fills.
  assert.equal(log.capped, false)
  assert.equal(log.shouldReport('flood-1.example'), true, 'the cap itself is said once')
  assert.equal(log.capped, true)
  for (let n = 2; n < 50; n += 1) {
    assert.equal(log.shouldReport(`flood-${String(n)}.example`), false)
  }
  assert.equal(log.reported, 3, 'and nothing past the cap is remembered, so the set stays bounded')

  assert.ok(MAX_REPORTED_HOSTS > 0, 'the default cap is a number of distinct values')
})
