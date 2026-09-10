/**
 * The premise, in a real browser: a card's markup sees the bridge by the time
 * its first parse-time script runs — and when the bootstrap does not arrive, it
 * sees nothing at all.
 *
 * **Why this exists and why it is not a unit test.** The frame's bootstrap moved
 * out of the `srcdoc` into a blocking classic `<script src>` on 2026-09-10
 * (`notes/apps/iris-web/DEVIATIONS.md` §91). Everything that move rests on is a
 * claim about a **browser's parser**: that a classic script with no `async`,
 * `defer` or `type` runs to completion before the parser reaches the next
 * element, so a card's inline `<script>` — which calls `getAllVariables()` on
 * its first line and draws a panel from the answer — finds the bridge already
 * installed. No amount of string assertion on the document can observe that.
 * `sandbox-srcdoc.test.ts` pins the tag's attributes and the order of the
 * elements; `tools/check-bootstrap.mjs` pins that the tag names this build's
 * artifact. This is the layer that watches the timing actually hold.
 *
 * **Four frames, and the third is what makes the first mean anything.**
 *
 * 1. **The real thing.** The real `buildSrcdoc` output, the real built
 *    bootstrap served from a real origin, and a card body whose first
 *    parse-time script records what it can see. Asserted: the bootstrap's
 *    marker is set, and `window.parent.document` — a bridged name, the one a
 *    card reaches for — does not throw.
 * 2. **The negative control: the bootstrap 404s.** Asserted: the shell receives
 *    a `bootstrap-error` naming the URL, the frame draws its named panel, the
 *    panel says **HTTP 404** rather than guessing at a bad build, and the card's
 *    markup **never ran** — no probe reading, and the element after the guard is
 *    not in the document at all. Without this, "the card can see the bridge" is
 *    a sentence about the happy path with nothing to fail.
 * 3. **The vacuity control: no bootstrap tag at all.** The same probe script in
 *    a bare sandboxed `srcdoc`. Asserted: `window.parent.document` **throws**.
 *    This is the one that stops (1) from being a test of nothing: if a
 *    cross-origin parent's `document` were readable anyway, (1) would be green
 *    with the bootstrap deleted. It carries no CSP, which is deliberate and
 *    irrelevant — the reading is about cross-origin access, which no policy of
 *    ours widens or narrows.
 * 4. **The other absence: a real script that is not the bootstrap.** The tag
 *    points at the member table — HTTP 200, loads, parses, sets no bootstrap
 *    marker, which is the shape a stale build or a wrong manifest entry takes.
 *    Asserted: the frame says *it arrived and set no marker*, and does **not**
 *    say 404. This frame exists because the guard's first version gave that
 *    sentence to the 404 as well (a 404 has a body, so a body-size test could
 *    not tell them apart) and this file was green while it did.
 *
 * **Gated on `IRIS_BROWSER=1`, not on whether a browser happens to be
 * installed.** The gate has to be a decision rather than a machine fact, or the
 * suite's skip count would depend on the machine — and
 * `scripts/check-corpus-skips.mjs` pins that count precisely so a test cannot
 * quietly stop running. With the flag set and no Chrome, or no
 * `public/sandbox` build, this **fails** and says which: asking for the check
 * and silently not getting it is the outcome the whole file is against.
 *
 * Run it with:
 *
 * ```
 * npm --prefix apps/iris-web run build:sandbox
 * IRIS_BROWSER=1 node --test apps/iris-web/tests/frame-bootstrap-live.test.ts
 * ```
 *
 * The CDP plumbing follows `tools/live-user-html-check.mjs`, including the part
 * that is not obvious: a sandboxed `srcdoc` frame refuses a per-target socket,
 * so the page session auto-attaches to its child frames and each reading is
 * evaluated through that frame's own session.
 *
 * @module iris-web/tests/frame-bootstrap-live
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer, type Server } from 'node:http'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createConnection } from 'node:net'

import { buildSrcdoc } from '../src/sandbox/srcdoc.ts'
import { frameSandbox } from '../src/sandbox/policy.ts'
import { parseSandboxManifest } from '../src/sandbox/asset-manifest.ts'
import { BOOTSTRAP_MISSING_MARK, BOOTSTRAP_SWALLOW_MARK } from '../src/sandbox/bootstrap-contract.ts'

/** Where the sandbox build writes. */
const SANDBOX_DIR = fileURLToPath(new URL('../public/sandbox', import.meta.url))

/** One token per frame, so a CDP session can say which frame it is attached to. */
const TOKENS = {
  live: 'a'.repeat(32),
  missing: 'b'.repeat(32),
  bare: 'c'.repeat(32),
  /** A real, loadable script that is simply not the bootstrap. */
  wrong: 'd'.repeat(32),
} as const

/**
 * The card body under test: one parse-time script, then one element.
 *
 * **The script is first and the element is after it on purpose.** The script's
 * position is the question — it is where a real card reads its variables — and
 * the element is the witness for the negative control: an element that parses
 * *after* the guard is the thing whose absence proves the guard stopped the
 * document rather than merely complained about it.
 *
 * The reading is written to a `data-` attribute rather than posted anywhere,
 * because in the live frame `window.parent` is already the virtual parent and
 * its `postMessage` means "remeasure my height" (§76). A DOM write is the one
 * channel that means the same thing in all three frames.
 */
const PROBE_BODY =
  '<script>'
  + 'try{'
  + "var bridged='unknown';"
  + "try{bridged=window.parent.document===undefined?'undefined':'reachable'}"
  + "catch(e){bridged='threw:'+(e&&e.name?e.name:String(e))}"
  + 'document.documentElement.setAttribute("data-iris-probe",JSON.stringify({'
  + 'marker:globalThis.__iris_bootstrap_ready__===true,'
  + 'markerType:typeof globalThis.__iris_bootstrap_ready__,'
  + 'spoke:globalThis.__iris_bootstrap_spoke__===true,'
  + 'members:typeof globalThis.__iris_members__,'
  + 'bridged:bridged,'
  + 'readyState:document.readyState,'
  + 'bodyChildren:document.body?document.body.children.length:-1'
  + '}))'
  + '}catch(e){document.documentElement.setAttribute("data-iris-probe-error",String(e))}'
  + '</script>'
  + '<div id="iris-probe-witness">witness</div>'

/** What one frame's probe reported. */
interface Probe {
  marker: boolean
  markerType: string
  spoke: boolean
  members: string
  bridged: string
  readyState: string
  bodyChildren: number
}

/** Whether a TCP port on loopback is free, checked rather than assumed. */
async function portFree(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const probe = createConnection({ host: '127.0.0.1', port })
    probe.on('connect', () => {
      probe.destroy()
      resolve(false)
    })
    probe.on('error', () => {
      resolve(true)
    })
  })
}

/**
 * A loopback port nothing is listening on.
 *
 * Checked rather than picked, because the failure of not checking is not a
 * failed launch: a Chrome that cannot claim the port exits, and every request
 * this test then makes goes to **whatever else** is on it. That has happened in
 * this repo with an application host and it wrote into a live data directory.
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
  const candidates = [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ]
  return candidates.find(path => existsSync(path))
}

/** Serve the built sandbox assets and one host page, with the host's headers. */
function serveFixture(pageHtml: string): Promise<{ server: Server, port: number }> {
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://iris.invalid').pathname
    /*
     * The two headers a frame's script load needs, copied from
     * `@iris/app-service`'s sandbox-asset route rather than invented: an opaque
     * origin needs `access-control-allow-origin` for `crossorigin="anonymous"`
     * to be a load rather than a refusal, and `timing-allow-origin` for the
     * guard's resource-timing reading to be anything but zeroes. That the real
     * host sends them is asserted where the real host is —
     * `apps/iris/tests/sandbox-cors.test.ts` — because a fixture agreeing with
     * itself proves nothing about the product.
     */
    const shared = { 'access-control-allow-origin': '*', 'timing-allow-origin': '*' }
    if (path === '/') {
      res.writeHead(200, { ...shared, 'content-type': 'text/html; charset=utf-8' })
      res.end(pageHtml)
      return
    }
    if (path.startsWith('/sandbox/')) {
      const name = path.slice('/sandbox/'.length)
      // A bare filename or nothing: this fixture is not a file server.
      if (name === '' || name.includes('/') || name.includes('..')) {
        res.writeHead(404, shared)
        res.end()
        return
      }
      let body: Buffer
      try {
        body = readFileSync(join(SANDBOX_DIR, name))
      } catch {
        res.writeHead(404, shared)
        res.end()
        return
      }
      const type = name.endsWith('.css')
        ? 'text/css; charset=utf-8'
        : name.endsWith('.json')
          ? 'application/json; charset=utf-8'
          : 'application/javascript; charset=utf-8'
      res.writeHead(200, { ...shared, 'content-type': type, 'content-length': body.byteLength })
      res.end(body)
      return
    }
    res.writeHead(404, shared)
    res.end()
  })
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      resolve({ server, port })
    })
  })
}

/** A CDP connection, with the one-envelope-per-id bookkeeping. */
interface Cdp {
  send: (method: string, params?: Record<string, unknown>, sessionId?: string) => Promise<Record<string, unknown>>
  sessions: Map<string, string>
  close: () => void
}

/** Open the browser-level socket and start collecting frame sessions. */
async function connect(port: number): Promise<Cdp> {
  const version = await fetch(`http://127.0.0.1:${port}/json/version`)
  const info = (await version.json()) as { webSocketDebuggerUrl?: string }
  const url = info.webSocketDebuggerUrl
  if (url === undefined) throw new Error('the browser debugging endpoint named no socket')

  const socket = new WebSocket(url)
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => {
      resolve()
    })
    socket.addEventListener('error', () => {
      reject(new Error('could not open the browser debugging socket'))
    })
  })

  let nextId = 1
  const pending = new Map<number, { resolve: (value: Record<string, unknown>) => void, reject: (error: Error) => void }>()
  /** Session id → target type, so an iframe session can be told from a page one. */
  const sessions = new Map<string, string>()

  socket.addEventListener('message', event => {
    const frame = JSON.parse(String((event as MessageEvent).data)) as {
      id?: number
      error?: { message?: string }
      result?: Record<string, unknown>
      method?: string
      params?: { sessionId?: string, targetInfo?: { type?: string } }
    }
    if (frame.id !== undefined) {
      const waiting = pending.get(frame.id)
      if (waiting === undefined) return
      pending.delete(frame.id)
      if (frame.error !== undefined) waiting.reject(new Error(frame.error.message ?? 'CDP error'))
      else waiting.resolve(frame.result ?? {})
      return
    }
    if (frame.method === 'Target.attachedToTarget') {
      const id = frame.params?.sessionId
      if (id !== undefined) sessions.set(id, frame.params?.targetInfo?.type ?? 'unknown')
    }
  })

  return {
    send: (method, params = {}, sessionId) => {
      const id = nextId
      nextId += 1
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject })
        socket.send(JSON.stringify(sessionId === undefined ? { id, method, params } : { id, method, params, sessionId }))
      })
    },
    sessions,
    close: () => {
      socket.close()
    },
  }
}

/** Evaluate an expression and return its value, refusing to swallow a throw. */
async function evaluate<T>(cdp: Cdp, sessionId: string, expression: string): Promise<T> {
  const result = (await cdp.send(
    'Runtime.evaluate',
    { expression, returnByValue: true, awaitPromise: true },
    sessionId,
  )) as { exceptionDetails?: unknown, result?: { value?: T } }
  if (result.exceptionDetails !== undefined) {
    throw new Error(`page eval failed: ${JSON.stringify(result.exceptionDetails)}`)
  }
  return result.result?.value as T
}

/** Poll until a condition holds, or say what was last seen. */
async function until<T>(what: string, read: () => Promise<T | undefined>, tries = 40): Promise<T> {
  let last: T | undefined
  for (let attempt = 0; attempt < tries; attempt += 1) {
    last = await read()
    if (last !== undefined) return last
    await new Promise(resolve => setTimeout(resolve, 150))
  }
  throw new Error(`${what} never happened (last reading: ${JSON.stringify(last)})`)
}

/**
 * Whether this run was asked for.
 *
 * A **decision**, not a capability check, so the suite's skip count is the same
 * on every machine. See the module comment.
 */
const asked = process.env['IRIS_BROWSER'] === '1'

test(
  'a card’s first parse-time script sees the bridge, and sees nothing when the bootstrap 404s',
  { skip: asked ? false : 'set IRIS_BROWSER=1 (and run build:sandbox) to drive a real browser over CDP' },
  async () => {
    /*
     * Both of these are failures rather than skips, and that is the point of the
     * gate above being a flag: the run was asked for, so not doing it is a
     * result someone has to see.
     */
    const manifestPath = join(SANDBOX_DIR, 'manifest.json')
    assert.ok(
      existsSync(manifestPath),
      `no ${manifestPath} — run "npm --prefix apps/iris-web run build:sandbox" before asking for IRIS_BROWSER=1`,
    )
    const assets = parseSandboxManifest(readFileSync(manifestPath, 'utf8'))
    assert.equal(typeof assets, 'object', `the sandbox manifest is unusable: ${String(assets)}`)
    if (typeof assets === 'string') return

    const binary = chromeBinary()
    assert.ok(
      binary !== undefined,
      'IRIS_BROWSER=1 was set but no Chrome was found — set CHROME_PATH to the binary',
    )

    /*
     * The host page. It does two things and neither is a decision: it mounts a
     * frame from a `srcdoc` string node hands it, with the **real**
     * `frameSandbox` attribute, and it records every message any frame posts.
     */
    const page = [
      '<!doctype html><html><head><meta charset="utf-8"><title>frame bootstrap probe</title></head>',
      '<body><script>',
      'window.__irisMessages = [];',
      "addEventListener('message', event => { try { window.__irisMessages.push(event.data) } catch (e) {} });",
      'window.__irisMount = (id, srcdoc, sandbox) => {',
      "  const frame = document.createElement('iframe');",
      '  frame.id = id;',
      "  frame.setAttribute('sandbox', sandbox);",
      '  frame.srcdoc = srcdoc;',
      '  document.body.appendChild(frame);',
      '  return id;',
      '};',
      '</script></body></html>',
    ].join('')

    const { server, port } = await serveFixture(page)
    const origin = `http://127.0.0.1:${port}`
    const profile = await mkdtemp(join(tmpdir(), 'iris-frame-probe-'))
    const debugPort = await freePort()

    let chrome: ChildProcess | undefined
    let cdp: Cdp | undefined
    try {
      chrome = spawn(
        binary as string,
        [
          '--headless=new',
          '--disable-gpu',
          '--no-first-run',
          '--no-default-browser-check',
          `--user-data-dir=${profile}`,
          `--remote-debugging-port=${String(debugPort)}`,
          'about:blank',
        ],
        { stdio: 'ignore' },
      )

      // The endpoint answering is the only honest signal that the port is ours.
      await until('the browser debugging endpoint came up', async () => {
        try {
          const probe = await fetch(`http://127.0.0.1:${debugPort}/json/version`)
          return probe.ok ? true : undefined
        } catch {
          return undefined
        }
      })

      cdp = await connect(debugPort)
      const target = (await cdp.send('Target.createTarget', { url: origin })) as { targetId?: string }
      assert.ok(target.targetId !== undefined, 'the browser opened no page')
      const attached = (await cdp.send('Target.attachToTarget', {
        targetId: target.targetId,
        flatten: true,
      })) as { sessionId?: string }
      const pageSession = attached.sessionId
      assert.ok(pageSession !== undefined, 'the page did not attach')

      await cdp.send('Runtime.enable', {}, pageSession)
      await cdp.send('Page.enable', {}, pageSession)
      await cdp.send(
        'Target.setAutoAttach',
        { autoAttach: true, waitForDebuggerOnStart: false, flatten: true },
        pageSession,
      )

      await until('the host page loaded its mount helper', async () =>
        (await evaluate<boolean>(cdp as Cdp, pageSession, "typeof window.__irisMount === 'function'"))
          ? true
          : undefined,
      )

      /** The frame shapes, all three from one assembly where there is one. */
      const shared = {
        networkGranted: false,
        libraries: [] as readonly string[],
        members: `${origin}${assets.members}`,
        selfOrigin: origin,
        body: PROBE_BODY,
        context: { variables: { hp: 5 } },
      }
      const documents: Record<keyof typeof TOKENS, string> = {
        live: buildSrcdoc(TOKENS.live, `${origin}${assets.bootstrap}`, shared),
        // The same assembly, pointed at a name the fixture answers with a 404.
        missing: buildSrcdoc(TOKENS.missing, `${origin}/sandbox/bootstrap-does-not-exist.js`, shared),
        /*
         * The same assembly, pointed at a **real, loadable, parseable** script
         * that simply is not the bootstrap — the member table. This is the shape
         * a stale build or a wrong manifest entry takes, and it is a different
         * report from a 404: the file arrived, HTTP 200, and set no marker. The
         * guard used to give this sentence to the 404 as well; pinning both
         * branches is what stops that from happening again in either direction.
         */
        wrong: buildSrcdoc(TOKENS.wrong, `${origin}${assets.members}`, shared),
        // Hand-built: no bootstrap, no guard, no policy. Only the probe.
        bare: [
          '<!doctype html><html><head><meta charset="utf-8">',
          `<meta name="iris-token" content="${TOKENS.bare}">`,
          '</head><body>',
          PROBE_BODY,
          '</body></html>',
        ].join(''),
      }

      for (const [id, srcdoc] of Object.entries(documents)) {
        await evaluate(
          cdp,
          pageSession,
          `window.__irisMount(${JSON.stringify(id)}, ${JSON.stringify(srcdoc)}, ${JSON.stringify(frameSandbox(false))})`,
        )
      }

      /*
       * Every frame's own session, keyed by the token in its head.
       *
       * The head parses before any of the three scripts in the body, so the
       * token is readable even in the frame whose parse was stopped — which is
       * what makes the stopped frame inspectable at all.
       */
      const byToken = await until('all four frames attached a session', async () => {
        const found = new Map<string, string>()
        for (const [sessionId, kind] of cdp?.sessions ?? []) {
          if (kind !== 'iframe') continue
          let token = ''
          try {
            token = await evaluate<string>(
              cdp as Cdp,
              sessionId,
              "(document.querySelector('meta[name=\"iris-token\"]') || {}).content || ''",
            )
          } catch {
            continue
          }
          if (token !== '') found.set(token, sessionId)
        }
        return found.size === 4 ? found : undefined
      })

      /** One frame's probe reading, or undefined while it has not run. */
      const probeOf = async (token: string): Promise<Probe | undefined> => {
        const session = byToken.get(token)
        assert.ok(session !== undefined, `no session for the frame with token ${token}`)
        const raw = await evaluate<string>(
          cdp as Cdp,
          session,
          "document.documentElement.getAttribute('data-iris-probe') || ''",
        )
        return raw === '' ? undefined : (JSON.parse(raw) as Probe)
      }

      // ── ① The real thing ────────────────────────────────────────────────
      /*
       * **Why this waits on the probe *or* the guard's panel rather than only on
       * the probe.** Measured: adding `defer` to the bootstrap tag makes the
       * guard fire in the live frame, which stops the parse — so the card script
       * never runs and the probe never appears. That is the guard working, but
       * without this branch the failure read "the live frame's card script ran
       * never happened (last reading: undefined)", which names a symptom and
       * hides a cause the frame is holding in its own DOM.
       */
      const liveSession = byToken.get(TOKENS.live)
      assert.ok(liveSession !== undefined)
      const live = await until('the live frame’s card script ran', async () => {
        const reading = await probeOf(TOKENS.live)
        if (reading !== undefined) return reading
        const refused = await evaluate<string>(
          cdp as Cdp,
          liveSession,
          `((document.querySelector('[${BOOTSTRAP_MISSING_MARK}]') || {}).textContent || '')`,
        )
        assert.equal(
          refused,
          '',
          'the frame with the real bootstrap URL reported the bootstrap as missing and stopped its own'
            + ` parse, so the card script never ran: ${refused}`,
        )
        return undefined
      })

      assert.equal(
        live.marker,
        true,
        `the card's first parse-time script found no bootstrap marker (${live.markerType}) —`
          + ' a fetched bootstrap does not finish before the body parses, which is the premise'
          + ` the whole move rests on. Reading: ${JSON.stringify(live)}`,
      )
      assert.equal(
        live.bridged,
        'reachable',
        `the card's first parse-time script could not read a bridged name: ${live.bridged}`,
      )
      assert.equal(live.spoke, false, 'the live bootstrap reported a failure of its own')
      assert.equal(live.members, 'object', 'the member table had not published by parse time either')
      assert.equal(
        live.readyState,
        'loading',
        `the probe ran at ${live.readyState}, not while the document was still parsing —`
          + ' the reading above is then about a later moment than the one under test',
      )

      // ── ③ The vacuity control ──────────────────────────────────────────
      const bare = await until('the bare frame’s script ran', async () => probeOf(TOKENS.bare))
      assert.equal(bare.marker, false, 'a frame with no bootstrap tag reported a bootstrap marker')
      assert.match(
        bare.bridged,
        /^threw:/,
        'a bridged name was readable in a frame with no bootstrap, so the live reading above'
          + ` distinguishes nothing: ${JSON.stringify(bare)}`,
      )

      // ── ② The negative control ─────────────────────────────────────────
      /*
       * Matched on the URL, not on being the first `bootstrap-error` in the
       * list. Two frames on this page fail — the 404 and the wrong-script one —
       * and they race: a `find` by type alone picked whichever arrived first and
       * then asserted the 404's URL against the other frame's message. The
       * report has to be identified by what it is about.
       */
      const errors = await until('the shell heard both broken frames report themselves', async () => {
        const messages = await evaluate<{ iris?: string, type?: string, message?: string }[]>(
          cdp as Cdp,
          pageSession,
          'window.__irisMessages',
        )
        const bootstrapErrors = messages.filter(message => message.type === 'bootstrap-error')
        return bootstrapErrors.length >= 2 ? bootstrapErrors : undefined
      })
      const reported = errors.find(message => String(message.message).includes('bootstrap-does-not-exist.js'))
      assert.ok(
        reported !== undefined,
        `no report names the URL that 404'd: ${JSON.stringify(errors)}`,
      )
      /*
       * And exactly two: one per broken frame, none from the two healthy ones.
       * A guard that fired on a working frame would be caught here rather than
       * by a reader wondering why the panel lists a failure for a card that drew
       * correctly.
       */
      assert.equal(
        errors.length,
        2,
        `two frames are broken and ${String(errors.length)} reported: ${JSON.stringify(errors)}`,
      )
      assert.equal(
        reported.iris,
        '',
        'the guard stamped a token it cannot know — the shell accepts this message on `event.source` alone',
      )

      const missingSession = byToken.get(TOKENS.missing)
      assert.ok(missingSession !== undefined)
      /*
       * The panel's own text is read below, not the body's. The body's
       * textContent begins with the source of the seed and the guard — they are
       * script elements, and a script element's text is text — so a first
       * version of this read two hundred characters of the guard and concluded
       * the panel said nothing.
       */
      const stopped = await evaluate<{ panel: boolean, swallowed: boolean, witness: boolean, probe: boolean, text: string }>(
        cdp,
        missingSession,
        `(() => ({
          panel: document.querySelector('[${BOOTSTRAP_MISSING_MARK}]') !== null,
          swallowed: document.querySelector('template[${BOOTSTRAP_SWALLOW_MARK}]') !== null,
          witness: document.getElementById('iris-probe-witness') !== null,
          probe: document.documentElement.hasAttribute('data-iris-probe'),
          text: (document.querySelector('[${BOOTSTRAP_MISSING_MARK}]') || {}).textContent || '',
        }))()`,
      )

      assert.equal(
        stopped.panel,
        true,
        `the frame drew no named failure panel, so it is blank for no stated reason: ${JSON.stringify(stopped)}`,
      )
      assert.equal(
        stopped.probe,
        false,
        "the card's markup ran anyway — it would now throw a ReferenceError per member, every one"
          + ` of them attributed to the card: ${JSON.stringify(stopped)}`,
      )
      assert.equal(
        stopped.witness,
        false,
        'the element after the guard is in the document, so the guard complained without stopping anything',
      )
      assert.equal(
        stopped.swallowed,
        true,
        'nothing swallowed the rest of the document; the parse stopped by `window.stop()` alone,'
          + ' which leaves no evidence in the DOM for whoever reads it next',
      )
      assert.match(
        stopped.text,
        /bootstrap did not install/,
        `the panel says nothing a reader can act on: ${JSON.stringify(stopped)}`,
      )
      /*
       * **And it says 404, not a guess.** The branch is pinned, not just the
       * sentence, because the first version of the guard answered every case
       * that had a body with "it arrived and set no marker: wrong bytes, a parse
       * error, or a stale build" — and a 404 has a body, so the commonest
       * failure of all sent the reader to the bundler. That wrong sentence read
       * as green here for exactly as long as this assertion was
       * `/did not install/` alone.
       */
      assert.match(
        stopped.text,
        /HTTP 404/,
        'the frame does not report the status the server answered, so a missing file and a broken'
          + ` build read the same: ${JSON.stringify(stopped)}`,
      )
      assert.doesNotMatch(
        stopped.text,
        /wrong bytes/,
        `a 404 is being diagnosed as a bad build: ${JSON.stringify(stopped)}`,
      )

      // ── ④ The other absence: a real script that is not the bootstrap ────
      const wrongSession = byToken.get(TOKENS.wrong)
      assert.ok(wrongSession !== undefined)
      const wrong = await until('the wrong-script frame reported itself', async () => {
        const text = await evaluate<string>(
          cdp as Cdp,
          wrongSession,
          `((document.querySelector('[${BOOTSTRAP_MISSING_MARK}]') || {}).textContent || '')`,
        )
        return text === '' ? undefined : text
      })
      assert.match(
        wrong,
        /it arrived \(HTTP 200, \d+ bytes\) and set no marker/,
        `a loadable script that is not the bootstrap is not reported as one: ${wrong}`,
      )
      assert.doesNotMatch(
        wrong,
        /HTTP 404|no response/,
        `a file that arrived is being reported as one that did not: ${wrong}`,
      )
    } finally {
      cdp?.close()
      chrome?.kill()
      await new Promise<void>(resolve => {
        server.close(() => {
          resolve()
        })
      })
      await rm(profile, { recursive: true, force: true }).catch(() => undefined)
    }
  },
)
