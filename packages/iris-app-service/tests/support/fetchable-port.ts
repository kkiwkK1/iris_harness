import type { AddressInfo, Server } from 'node:net'

/**
 * Ephemeral ports that `fetch` will actually talk to.
 *
 * `listen(0)` asks the OS for any free port, and on Windows the default dynamic
 * range starts at 1024 (`netsh int ipv4 show dynamicport tcp`: start 1024,
 * 13977 ports). Nineteen entries of Fetch's blocked-port table fall inside that
 * range, so a test that binds `port: 0` and then fetches its own server draws a
 * blocked one every so often and fails with `TypeError: fetch failed` /
 * `[cause] Error: bad port` — which reads as a host bug rather than as the
 * client refusing to dial. Measured: one full-suite run in six, two at a time,
 * failed on it, and a single serial run failed on it too (
 * `iris-llm-openai-compat`'s `timeouts.test.ts`, drawing 1723).
 *
 * Every caller that binds an ephemeral port and then reaches it over `fetch`
 * goes through here, so the knowledge lives in one place rather than in a
 * per-file constant that the next such test will not know to copy.
 *
 * **Why this file is under `iris-app-service/tests/support/`**: it is the only
 * shared test-support directory in the tree and is already imported across
 * trees (`apps/iris/tests/live-generation-kinds.test.ts` reaches
 * `materialising-store.ts` by relative path). This module imports nothing of
 * ours, so it adds no package dependency in either direction — only a
 * test-only file path. If a neutral shared location is ever created, this moves
 * there unchanged.
 */

/**
 * The WHATWG Fetch "bad port" table, in full.
 *
 * Source: WHATWG Fetch, § "block bad port" — the `bad ports` table
 * (https://fetch.spec.whatwg.org/#bad-port). Node's `fetch` (undici) enforces
 * it and reports `bad port` as the request's cause, before any connection is
 * attempted.
 *
 * **The whole table, not the part this machine happens to draw.** Only 19 of
 * these are inside Windows' default dynamic range, and it is tempting to keep
 * just those; but the dynamic range is a registry setting, Linux's starts at
 * 32768, and a container's may start anywhere. A list trimmed to one machine's
 * range is a list that stops being true when the machine changes, and the
 * symptom then is a rare red in unrelated code.
 *
 * Verified against this runtime rather than transcribed and trusted: every port
 * in 1..11000 was fetched on 127.0.0.1 and exactly these 82 were refused with
 * `bad port` (Node v24.13.0, 2026-09-07) — no entry here that the runtime
 * allows, no port the runtime refuses that is missing here.
 * `fetchable-port.test.ts` re-asks the second half of that question every run.
 */
export const FETCH_BAD_PORTS: ReadonlySet<number> = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79,
  87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137,
  139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532,
  540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723,
  2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669,
  6679, 6697, 10080,
])

/**
 * Whether `fetch` would refuse a URL on this port outright.
 * @param port - the port a bind settled on.
 * @returns true when the port is on {@link FETCH_BAD_PORTS}.
 */
export function isFetchBadPort(port: number): boolean {
  return FETCH_BAD_PORTS.has(port)
}

/**
 * How many draws before a run of blocked ports stops looking like luck.
 *
 * With 19 blocked ports in a 13977-wide range, twenty consecutive blocked draws
 * has probability about 1e-58. Reaching this cap means the allocator is not
 * random — the port is being chosen for us — and that is worth a named failure
 * rather than an endless loop.
 */
const ATTEMPTS = 20

/** What one attempt at claiming an ephemeral port produced. */
export interface Bound<T> {
  /** Whatever the caller needs to keep — a server, a fiber, a handle. */
  value: T
  /** The port it actually claimed. */
  port: number
  /** Give the port back, because it was one `fetch` refuses. */
  release: () => Promise<void> | void
}

/**
 * Claim an ephemeral port until it is one `fetch` will talk to.
 *
 * Retries the bind rather than picking a port itself: asking for a specific free
 * port means a window between finding it free and claiming it, and a collision
 * there is how a test ends up talking to somebody else's server — which has
 * happened in this repo, to a QA host that wrote eleven chats into someone
 * else's profile.
 * @param bind - claims a port and reports what it claimed. Called again after
 *   `release` when the port it drew was blocked.
 * @returns the accepted binding.
 */
export async function onFetchablePort<T>(bind: () => Promise<Bound<T>>): Promise<{ value: T, port: number }> {
  const drawn: number[] = []
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    const bound = await bind()
    if (!isFetchBadPort(bound.port)) return { value: bound.value, port: bound.port }
    drawn.push(bound.port)
    await bound.release()
  }
  throw new Error(
    `${String(ATTEMPTS)} ephemeral ports in a row were on fetch’s blocked list, which is not luck: `
    + `${drawn.join(', ')}`,
  )
}

/**
 * Listen on an ephemeral port `fetch` will talk to, and report it.
 *
 * The server is left listening on the accepted port; a rejected one is closed
 * before the next attempt, so no attempt leaks a listener. The caller still owns
 * closing the server it passed in.
 * @param server - a server that has not been told to listen yet.
 * @param host - the interface to bind; loopback by default, because a test
 *   server on `0.0.0.0` is a service on the network.
 * @returns the port it settled on.
 */
export async function listenOnFetchablePort(server: Server, host = '127.0.0.1'): Promise<number> {
  const { port } = await onFetchablePort(async () => {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        server.removeListener('listening', onListening)
        reject(error)
      }
      const onListening = (): void => {
        server.removeListener('error', onError)
        resolve()
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(0, host)
    })
    const address = server.address()
    // A refusal with a voice: `null` here means the bind did not take, and
    // returning port 0 would have every caller build `http://127.0.0.1:0`.
    if (address === null || typeof address === 'string') {
      throw new Error(`listening on ${host}:0 produced no address (got ${JSON.stringify(address)})`)
    }
    return {
      value: server,
      port: (address as AddressInfo).port,
      release: () => new Promise<void>((resolve, reject) => {
        server.close(error => { if (error) reject(error); else resolve() })
      }),
    }
  })
  return port
}
