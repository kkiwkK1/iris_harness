import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import type { Context } from '@deepseek-ai/cordis'
import { boot } from '@deepseek-ai/dsh-app-boot'
import type {} from '@deepseek-ai/dsh-host-webserver'

/**
 * The shell's Content-Security-Policy, in a real browser, on a real host.
 *
 * **Why this file exists at all, and why it is the file that decides the
 * policy.** The audit asked for the textbook shell policy — `default-src
 * 'self'`, `script-src 'self' 'nonce-…'`, no `'unsafe-inline'`, no
 * `'unsafe-eval'` — and that policy cannot ship. A card interface is an
 * `<iframe srcdoc>`; `about:srcdoc` is a *local scheme*; and a document with a
 * local-scheme URL **inherits its embedder's policy**, which the browser then
 * enforces alongside the document's own. The frame's own policy is the
 * permissive one card code needs; intersect it with a strict shell policy and
 * nothing in any card runs. No string assertion can see that — it is a fact
 * about a browser's policy inheritance — so it is measured here, with both
 * halves of the reading in the same file:
 *
 * - the shipped policy leaves a card-shaped frame running (test 1), and
 * - the policy that was asked for stops it dead (test 2), against a control
 *   page carrying no policy at all where the same frame runs.
 *
 * Test 2 is not a regression net. It is the evidence for a deliberate
 * departure, kept executable so that the day the frames stop being `srcdoc` —
 * served from a real same-origin URL, sandboxed to an opaque origin, policy in
 * their own response — somebody runs it, watches it go green the other way, and
 * ships the strict policy. (`notes/apps/iris-web/DEVIATIONS.md` §93,
 * `notes/packages/iris-app-service/DEVIATIONS.md` §74.)
 *
 * **Gated on `IRIS_BROWSER=1`, not on whether a browser is installed**, for the
 * reason `apps/iris-web/tests/frame-bootstrap-live.test.ts` gives: the suite's
 * skip count must be a decision rather than a machine fact, since
 * `scripts/check-corpus-skips.mjs` pins it. With the flag set and no Chrome, or
 * no `apps/iris-web/dist`, this **fails** and says which.
 *
 * ```
 * npm --prefix apps/iris-web run build
 * IRIS_BROWSER=1 node --test apps/iris/tests/shell-csp-live.test.ts
 * ```
 *
 * @module apps/iris/tests/shell-csp-live
 */

/** Whether this run was asked for. A decision, not a capability check. */
const asked = process.env['IRIS_BROWSER'] === '1'

/** The built shell. Its index is what the host serves and taps. */
const DIST_INDEX = fileURLToPath(new URL('../../iris-web/dist/index.html', import.meta.url))

/** The magic string a WebSocket server hashes the client's key with. */
const WS_GUID = '258EAFA5-E914-47DA-95CA-5AB0DC85B11F'

/**
 * A card-shaped frame, as a string of JavaScript the page evaluates.
 *
 * Not `buildSrcdoc`'s output — `apps/iris-web` is deliberately unreachable from
 * here, the same architecture rule `allowlist-drift.test.ts` writes about — but
 * the shape that matters is reproduced exactly: `sandbox="allow-scripts"` (an
 * opaque origin, which is what `frameSandbox` writes for an ungranted card), a
 * `srcdoc` document carrying **its own** permissive policy in a `<meta>`, one
 * parse-time inline script, and one `new Function`. Those are the two things
 * every real card needs and the two the shell's policy could take away.
 */
const MOUNT_CARD_FRAME = `(() => {
  const policy = [
    "default-src 'none'",
    "script-src 'unsafe-inline' 'unsafe-eval' blob:",
    "style-src 'unsafe-inline'",
    "img-src data: blob:",
  ].join('; ')
  const body = '<!doctype html><html><head><meta charset="utf-8">'
    + '<meta http-equiv="Content-Security-Policy" content="' + policy + '">'
    + '</head><body><scr' + 'ipt>'
    + 'window.__cardRan = true;'
    + 'try { window.__cardEvaled = new Function("return 1 + 1")() }'
    + ' catch (e) { window.__cardEvaled = "BLOCKED:" + (e && e.message) }'
    + '</scr' + 'ipt><div id="card-witness">drawn</div></body></html>'
  const frame = document.createElement('iframe')
  frame.id = 'iris-card-probe'
  frame.setAttribute('sandbox', 'allow-scripts')
  frame.srcdoc = body
  document.body.appendChild(frame)
  return true
})()`

/** What the probe frame reports about itself, read through its own session. */
const READ_CARD_FRAME =
  'JSON.stringify({ran: window.__cardRan === true, evaled: window.__cardEvaled,'
  + ' witness: !!document.getElementById("card-witness"), url: location.href})'

let ctx: Context | undefined
let dataDir = ''
let fixture: Server | undefined
let fixturePort = 0
let hostPort = 0
let chrome: ChildProcess | undefined
let cdp: Cdp | undefined
let profile = ''

/** One JavaScript realm the browser has told us about. */
interface Realm {
  /** The page session it was announced on. */
  session: string
  /** The realm's id, for `Runtime.evaluate`. */
  id: number
  /** The realm's security origin, which is how a framed page is found. */
  origin: string
}

/** A CDP connection with one-envelope-per-id bookkeeping and two tables. */
interface Cdp {
  send: (method: string, params?: Record<string, unknown>, sessionId?: string) => Promise<Record<string, unknown>>
  sessions: Map<string, { type: string, url: string }>
  /**
   * Every execution context announced, child frames included.
   *
   * Needed beside the session table because **a same-site cross-origin frame
   * gets no target of its own**: Chrome isolates by *site*, and two ports on
   * `127.0.0.1` are the same site, so the click-jacking frame this test mounts
   * runs in the parent's process and attaches no session. It is still a
   * separate origin — the parent cannot read it — so the only handle on it is
   * its execution context id.
   */
  realms: Realm[]
  close: () => void
}

/** Whether a loopback port has nothing listening on it. */
async function portFree(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const probe = net.connect({ host: '127.0.0.1', port })
    probe.on('connect', () => { probe.destroy(); resolve(false) })
    probe.on('error', () => { resolve(true) })
  })
}

/**
 * A loopback port nothing is listening on.
 *
 * Checked rather than picked. A Chrome that cannot claim its debugging port
 * exits, and every request this test then makes goes to **whatever else** is on
 * it — which has happened in this repo with an application host and wrote into
 * a live data directory.
 */
async function freePort(): Promise<number> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const port = 9400 + Math.floor(Math.random() * 400)
    if (await portFree(port)) return port
  }
  throw new Error('no free loopback port found for the browser debugging endpoint')
}

/** Chrome's location, from the environment or the platform's usual place. */
function chromeBinary(): string | undefined {
  const named = process.env['CHROME_PATH']
  if (named !== undefined && named !== '' && existsSync(named)) return named
  return [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].find(path => existsSync(path))
}

/** Wait a while. */
async function pause(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** Poll until a condition holds, or say what was last seen. */
async function until<T>(what: string, read: () => Promise<T | undefined>, tries = 40): Promise<T> {
  let last: T | undefined
  for (let attempt = 0; attempt < tries; attempt += 1) {
    last = await read()
    if (last !== undefined) return last
    await pause(150)
  }
  throw new Error(`${what} never happened (last reading: ${JSON.stringify(last)})`)
}

/**
 * The pages this test needs that the host cannot serve.
 *
 * Three of them, on an origin that is **not** the host's — which is the point
 * for two: a click-jacking frame comes from somewhere else by definition, and a
 * control page has to be able to carry a policy the host would never write.
 */
function serveFixture(): Promise<{ server: Server, port: number }> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://iris.invalid')
    if (url.pathname === '/framer') {
      // The click-jacker: the shell, in a frame, from another origin.
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end('<!doctype html><html><head><meta charset="utf-8"><title>framer</title></head><body>'
        + `<iframe id="victim" src="http://127.0.0.1:${String(hostPort)}/" width="900" height="700"></iframe>`
        + '</body></html>')
      return
    }
    if (url.pathname === '/ws-probe') {
      /*
       * `connect-src 'self'` and a WebSocket: a browser fact, read here because
       * it decides whether a future strict shell policy would need a `ws:`
       * entry beside `'self'` (CSP2 did not match `ws:` against `'self'`; CSP3
       * does).
       *
       * **The reading is the policy's, not the handshake's.** CSP decides
       * before a connection is attempted, so what is asserted is which sockets
       * raised a `securitypolicyviolation` — and the cross-origin socket is
       * there to make the same-origin silence mean something. Whether either
       * one completes a handshake is a different question this does not ask.
       *
       * The probe's own script is nonced because `default-src 'self'` refuses
       * an inline script, and a probe whose script never ran would report "no
       * violations" for the same reason a passing one does.
       */
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end('<!doctype html><html><head><meta charset="utf-8">'
        + '<meta http-equiv="Content-Security-Policy" content="default-src \'self\'; '
        + 'script-src \'self\' \'nonce-wsprobe\'; connect-src \'self\'">'
        + '</head><body><script nonce="wsprobe">'
        + 'window.__v = []; window.__log = [];'
        + "addEventListener('securitypolicyviolation', e => { window.__v.push(e.effectiveDirective) });"
        + "try { new WebSocket('ws://' + location.host + '/socket') } catch (e) { window.__log.push('same:threw') }"
        + `try { new WebSocket('ws://127.0.0.1:${String(hostPort)}/iris/events') }`
        + " catch (e) { window.__log.push('other:threw') }"
        + "fetch('/echo').then(r => window.__log.push('fetch:' + r.status))"
        + " .catch(() => window.__log.push('fetch:err'));"
        + '</script></body></html>')
      return
    }
    if (url.pathname === '/echo') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"ok":true}')
      return
    }
    // `/control` carries no policy; `/strict` carries the one the audit asked
    // for. Same document otherwise, which is what makes the pair a reading.
    const strict = url.pathname === '/strict'
    const meta = strict
      ? '<meta http-equiv="Content-Security-Policy" content="default-src \'self\'; '
        + "script-src 'self' 'nonce-probe-nonce'; object-src 'none'; base-uri 'none'\">"
      : ''
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(`<!doctype html><html><head><meta charset="utf-8">${meta}<title>probe</title></head>`
      + `<body><script${strict ? ' nonce="probe-nonce"' : ''}>window.__ready = true;</script></body></html>`)
  })
  server.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'] ?? ''
    const accept = createHash('sha1').update(`${key}${WS_GUID}`).digest('base64')
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
      + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`)
    socket.on('error', () => { /* the page hangs up when the test is done */ })
  })
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolve({ server, port: typeof address === 'object' && address !== null ? address.port : 0 })
    })
  })
}

/** Open the browser-level socket and start collecting frame sessions. */
async function connect(port: number): Promise<Cdp> {
  const info = (await (await fetch(`http://127.0.0.1:${String(port)}/json/version`)).json()) as {
    webSocketDebuggerUrl?: string
  }
  const url = info.webSocketDebuggerUrl
  if (url === undefined) throw new Error('the browser debugging endpoint named no socket')

  const socket = new WebSocket(url)
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => { resolve() })
    socket.addEventListener('error', () => { reject(new Error('could not open the browser debugging socket')) })
  })

  let nextId = 1
  const pending = new Map<number, (value: Record<string, unknown>) => void>()
  const rejects = new Map<number, (error: Error) => void>()
  const sessions = new Map<string, { type: string, url: string }>()
  const realms: Realm[] = []

  socket.addEventListener('message', event => {
    const frame = JSON.parse(String((event as MessageEvent).data)) as {
      id?: number
      sessionId?: string
      error?: { message?: string }
      result?: Record<string, unknown>
      method?: string
      params?: {
        sessionId?: string
        targetInfo?: { type?: string, url?: string }
        context?: { id?: number, origin?: string }
      }
    }
    if (frame.id !== undefined) {
      const resolve = pending.get(frame.id)
      const reject = rejects.get(frame.id)
      pending.delete(frame.id)
      rejects.delete(frame.id)
      if (frame.error !== undefined) reject?.(new Error(frame.error.message ?? 'CDP error'))
      else resolve?.(frame.result ?? {})
      return
    }
    if (frame.method === 'Target.attachedToTarget') {
      const id = frame.params?.sessionId
      if (id !== undefined) {
        sessions.set(id, {
          type: frame.params?.targetInfo?.type ?? 'unknown',
          url: frame.params?.targetInfo?.url ?? '',
        })
      }
      return
    }
    if (frame.method === 'Runtime.executionContextCreated') {
      const context = frame.params?.context
      if (context?.id !== undefined && frame.sessionId !== undefined) {
        realms.push({ session: frame.sessionId, id: context.id, origin: context.origin ?? '' })
      }
    }
  })

  return {
    send: (method, params = {}, sessionId) => {
      const id = nextId
      nextId += 1
      return new Promise((resolve, reject) => {
        pending.set(id, resolve)
        rejects.set(id, reject)
        socket.send(JSON.stringify(sessionId === undefined ? { id, method, params } : { id, method, params, sessionId }))
      })
    },
    sessions,
    realms,
    close: () => { socket.close() },
  }
}

/** Evaluate an expression in one session, refusing to swallow a throw. */
async function evaluate<T>(sessionId: string, expression: string, contextId?: number): Promise<T> {
  const result = (await (cdp as Cdp).send(
    'Runtime.evaluate',
    contextId === undefined
      ? { expression, returnByValue: true, awaitPromise: true }
      : { expression, returnByValue: true, awaitPromise: true, contextId },
    sessionId,
  )) as { exceptionDetails?: unknown, result?: { value?: T } }
  if (result.exceptionDetails !== undefined) {
    throw new Error(`page eval failed: ${JSON.stringify(result.exceptionDetails)}`)
  }
  return result.result?.value as T
}

/**
 * Open one page, with violation collection armed before anything parses.
 * @param url - where to go.
 * @returns the page's session id and its target id.
 */
async function open(url: string): Promise<{ session: string, target: string }> {
  const created = (await (cdp as Cdp).send('Target.createTarget', { url: 'about:blank' })) as { targetId?: string }
  const targetId = created.targetId as string
  const attached = (await (cdp as Cdp).send('Target.attachToTarget', {
    targetId,
    flatten: true,
  })) as { sessionId?: string }
  const session = attached.sessionId as string
  await (cdp as Cdp).send('Runtime.enable', {}, session)
  await (cdp as Cdp).send('Page.enable', {}, session)
  await (cdp as Cdp).send(
    'Target.setAutoAttach',
    { autoAttach: true, waitForDebuggerOnStart: false, flatten: true },
    session,
  )
  /*
   * The listener is installed as a *new-document* script rather than after
   * navigation, because a violation raised while the document is still parsing
   * — which is exactly when an inline script is refused — happens before any
   * `Runtime.evaluate` this test could send.
   */
  await (cdp as Cdp).send('Page.addScriptToEvaluateOnNewDocument', {
    source: 'window.__violations = [];'
      + "addEventListener('securitypolicyviolation', e => {"
      + ' window.__violations.push(e.effectiveDirective + " " + e.blockedURI) });',
  }, session)
  await (cdp as Cdp).send('Page.navigate', { url }, session)
  return { session, target: targetId }
}

/** Every violation one page has seen so far. */
async function violations(session: string): Promise<string[]> {
  return evaluate<string[]>(session, 'JSON.stringify(window.__violations || [])')
    .then(raw => JSON.parse(String(raw)) as string[])
}

before(async () => {
  if (!asked) return

  dataDir = await mkdtemp(join(tmpdir(), 'iris-shellcsp-'))
  await mkdir(join(dataDir, 'default-user', 'characters'), { recursive: true })

  process.env.IRIS_TEST_DATA_DIR = dataDir
  process.env.IRIS_TEST_WEB_DIST = DIST_INDEX

  ctx = await boot('iris-shell-csp-live', fileURLToPath(new URL('./fixtures/shell-index.cordis.yml', import.meta.url)))
  hostPort = ctx.webServer.port

  const served = await serveFixture()
  fixture = served.server
  fixturePort = served.port

  const binary = chromeBinary()
  if (binary === undefined) return

  profile = await mkdtemp(join(tmpdir(), 'iris-shellcsp-profile-'))
  const debugPort = await freePort()
  chrome = spawn(binary, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${String(debugPort)}`,
    'about:blank',
  ], { stdio: 'ignore' })

  await until('the browser debugging endpoint came up', async () => {
    try {
      const probe = await fetch(`http://127.0.0.1:${String(debugPort)}/json/version`)
      return probe.ok ? true : undefined
    } catch {
      return undefined
    }
  })
  cdp = await connect(debugPort)
})

after(async () => {
  cdp?.close()
  chrome?.kill()
  fixture?.close()
  if (ctx !== undefined) await ctx.fiber.dispose()
  if (profile !== '') await rm(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 })
  if (dataDir !== '') await rm(dataDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 })
})

/** The two preconditions that are failures rather than skips once asked for. */
function demandHarness(): void {
  assert.ok(
    existsSync(DIST_INDEX),
    `no ${DIST_INDEX} — run "npm --prefix apps/iris-web run build" before asking for IRIS_BROWSER=1`,
  )
  assert.ok(cdp !== undefined, 'IRIS_BROWSER=1 was set but no Chrome was found — set CHROME_PATH to the binary')
}

test(
  'the shipped shell loads under its own policy with no violation, and a card frame still runs inside it',
  { skip: asked ? false : 'set IRIS_BROWSER=1 (and run apps/iris-web build) to drive a real browser over CDP' },
  async () => {
    demandHarness()

    const page = await open(`http://127.0.0.1:${String(hostPort)}/`)

    // The policy really is on the document the browser parsed, not only in the
    // bytes the host wrote — read back from the DOM.
    const declared = await until('the shell page parsed its head', async () => {
      const read = await evaluate<string | null>(
        page.session,
        'document.querySelector(\'meta[http-equiv="Content-Security-Policy"]\')?.content ?? null',
      )
      return read === null ? undefined : read
    })
    assert.match(declared, /base-uri 'none'/)
    assert.match(declared, /object-src 'none'/)
    assert.match(declared, /form-action 'none'/)

    // The bundle ran: `#root` is filled by the shell's own boot, which also
    // means the module script, the stylesheet and the two inline scripts were
    // all admitted.
    const mounted = await until('the shell mounted its interface', async () => {
      const count = await evaluate<number>(page.session, 'document.getElementById("root")?.children.length ?? 0')
      return count > 0 ? count : undefined
    })
    assert.ok(mounted > 0)

    // A card-shaped frame, inside the real document, under the real policy.
    await evaluate(page.session, MOUNT_CARD_FRAME)
    const card = await until('the card frame attached a session', async () => {
      for (const [id, info] of (cdp as Cdp).sessions) {
        if (info.type !== 'iframe') continue
        const raw = await evaluate<string>(id, READ_CARD_FRAME).catch(() => undefined)
        if (raw === undefined) continue
        return JSON.parse(raw) as { ran: boolean, evaled: unknown, witness: boolean, url: string }
      }
      return undefined
    })

    assert.equal(card.url, 'about:srcdoc', 'the probe attached to something that is not the card frame')
    assert.equal(card.witness, true, 'the frame parsed its markup')
    assert.equal(
      card.ran,
      true,
      'the card frame’s parse-time script did not run under the shipped shell policy —'
        + ' a srcdoc frame inherits it, so a directive was added here that every card pays for',
    )
    assert.equal(
      card.evaled,
      2,
      'the card frame lost `new Function` — the shell policy now carries a script-src the frame inherits',
    )

    // And the page itself saw nothing refused, frames included.
    assert.deepEqual(await violations(page.session), [], 'the shell refused something of its own')
  },
)

test(
  'the strict policy the audit asked for would stop every card frame, which is why it is not shipped',
  { skip: asked ? false : 'set IRIS_BROWSER=1 to drive a real browser over CDP' },
  async () => {
    demandHarness()

    /*
     * The control first. Same document, same frame, no policy: if this one did
     * not run the card, the strict reading below would be a test of nothing.
     */
    const control = await open(`http://127.0.0.1:${String(fixturePort)}/control`)
    await until('the control page is ready', async () =>
      (await evaluate<boolean>(control.session, 'window.__ready === true')) ? true : undefined)
    await evaluate(control.session, MOUNT_CARD_FRAME)
    const ran = await until('the control’s card frame reported', async () => {
      for (const [id, info] of (cdp as Cdp).sessions) {
        if (info.type !== 'iframe') continue
        const raw = await evaluate<string>(id, READ_CARD_FRAME).catch(() => undefined)
        if (raw === undefined) continue
        const read = JSON.parse(raw) as { ran: boolean, evaled: unknown }
        return read.ran ? read : undefined
      }
      return undefined
    })
    assert.equal(ran.evaled, 2, 'the control card frame could not eval; the reading below means nothing')
    await (cdp as Cdp).send('Target.closeTarget', { targetId: control.target })
    ;(cdp as Cdp).sessions.clear()

    // The same frame, under `default-src 'self'; script-src 'self' 'nonce-…'`.
    const strict = await open(`http://127.0.0.1:${String(fixturePort)}/strict`)
    await until('the strict page is ready', async () =>
      (await evaluate<boolean>(strict.session, 'window.__ready === true')) ? true : undefined)
    await evaluate(strict.session, MOUNT_CARD_FRAME)
    const blocked = await until('the strict page’s card frame reported', async () => {
      for (const [id, info] of (cdp as Cdp).sessions) {
        if (info.type !== 'iframe') continue
        const raw = await evaluate<string>(id, READ_CARD_FRAME).catch(() => undefined)
        if (raw === undefined) continue
        const read = JSON.parse(raw) as { ran: boolean, witness: boolean }
        return read.witness ? read : undefined
      }
      return undefined
    })

    assert.equal(blocked.witness, true, 'the frame was created and its markup parsed')
    assert.equal(
      blocked.ran,
      false,
      'the card frame ran its inline script under a strict shell policy —'
        + ' if this is true, srcdoc inheritance has changed and the strict policy can ship (§93)',
    )
  },
)

test(
  'the shell refuses to render when another origin frames it',
  { skip: asked ? false : 'set IRIS_BROWSER=1 to drive a real browser over CDP' },
  async () => {
    demandHarness()
    ;(cdp as Cdp).realms.length = 0

    const framer = await open(`http://127.0.0.1:${String(fixturePort)}/framer`)
    const hostOrigin = `http://127.0.0.1:${String(hostPort)}`

    /*
     * Read through the frame's *execution context*, not through a session of
     * its own. Chrome isolates by site, and two ports on `127.0.0.1` are the
     * same site, so the framed shell shares the framer's process and attaches
     * no target — while still being a separate *origin* the framer cannot read.
     * Its context id is the only handle on it.
     */
    const victim = await until('the framed shell announced a realm', async () => {
      for (const realm of (cdp as Cdp).realms) {
        if (realm.origin !== hostOrigin) continue
        const raw = await evaluate<string>(
          realm.session,
          'JSON.stringify({href: location.href,'
          + ' refused: document.body?.getAttribute("data-iris-framed") ?? null,'
          + ' text: (document.body?.textContent ?? "").slice(0, 60),'
          + ' rootChildren: document.getElementById("root")?.children.length ?? -1})',
          realm.id,
        ).catch(() => undefined)
        if (raw === undefined) continue
        return JSON.parse(raw) as {
          href: string
          refused: string | null
          text: string
          rootChildren: number
        }
      }
      return undefined
    })

    assert.equal(victim.refused, 'refused', 'a framed shell rendered itself')
    assert.match(victim.text, /Iris/, 'and it says something the reader can act on')
    assert.equal(
      victim.rootChildren,
      -1,
      'the framed shell still has a #root — the parser was not stopped and the app may have booted',
    )
    await (cdp as Cdp).send('Target.closeTarget', { targetId: framer.target })
  },
)

test(
  'a same-host WebSocket connects under connect-src \'self\', so a future strict policy needs no ws: entry',
  { skip: asked ? false : 'set IRIS_BROWSER=1 to drive a real browser over CDP' },
  async () => {
    demandHarness()

    /*
     * Recorded rather than required: the shipped policy carries no
     * `connect-src` (a card frame inherits it and an ungranted frame's own
     * `connect-src 'none'` is not the question — a *granted* one's `https:` is).
     * This is the browser fact the day the shell can carry one, and it is worth
     * a measurement because CSP2 did not match `ws:` against `'self'` and CSP3
     * does. The page here is the fixture's own origin so the socket is genuinely
     * same-host.
     */
    const probe = await open(`http://127.0.0.1:${String(fixturePort)}/ws-probe`)
    const reading = await until('the ws probe reported', async () => {
      const raw = await evaluate<string>(probe.session, 'JSON.stringify({v: window.__v, log: window.__log})')
      const read = JSON.parse(String(raw)) as { v: string[], log: string[] }
      return read.log.includes('fetch:200') ? read : undefined
    })

    /*
     * One violation, and it is the cross-origin socket's. Its presence is what
     * makes the same-origin socket's absence a reading rather than a listener
     * that never fired: both sockets are opened by the same script on the same
     * page under the same policy, and only one of them is refused.
     */
    assert.deepEqual(
      reading.v,
      ['connect-src'],
      `expected exactly the cross-origin socket to be refused: ${JSON.stringify(reading)}`,
    )
    assert.deepEqual(reading.log, ['fetch:200'], 'neither `new WebSocket` should throw synchronously')
    await (cdp as Cdp).send('Target.closeTarget', { targetId: probe.target })
  },
)
