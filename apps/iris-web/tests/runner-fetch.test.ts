import assert from 'node:assert/strict'
import { test } from 'node:test'

import { runCard, type RunnerHost } from '../src/sandbox/runner.ts'

/**
 * The host side of the same-origin fetch bridge.
 *
 * The frame decides what to bridge; this side re-decides, because the frame is
 * the untrusted half and the shell is what holds the credentials. The harness
 * is the runner's own shape: a stub document whose window carries a `location`
 * and a `fetch`, so a message can be delivered and both routes observed
 * without a browser.
 */
function harness(host?: Partial<RunnerHost>): {
  card: ReturnType<typeof runCard>
  /** Deliver a frame message, as the frame's own window. */
  fromFrame: (message: unknown) => void
  /** What the runner posted into the frame, in order. */
  posted: () => Record<string, unknown>[]
  /** What the shell page's own fetch was asked for. */
  sameOriginCalls: () => string[]
  /** What reached the shell's `host.fetch` (the allowlisted remote route). */
  hostFetches: () => string[]
  /** Make the shell page's next same-origin fetch fail. */
  failNextRide: (why: Error) => void
  /** What the shell reported on the note channel. */
  notes: () => string[]
} {
  const posted: Record<string, unknown>[] = []
  const sameOriginCalls: string[] = []
  const hostFetches: string[] = []
  const notes: string[] = []
  let pendingFailure: Error | undefined

  const contentWindow = {
    postMessage: (message: unknown) => {
      posted.push(message as Record<string, unknown>)
    },
  }
  const element = {
    style: { setProperty: () => undefined, removeProperty: () => undefined },
    dataset: {} as Record<string, string>,
    contentWindow,
    srcdoc: '',
    setAttribute: () => undefined,
    remove: () => undefined,
  }
  const handlers = new Map<string, ((event: unknown) => void)[]>()
  const docHandlers = new Map<string, ((event: unknown) => void)[]>()
  const view = {
    location: { origin: 'http://127.0.0.1:8791', href: 'http://127.0.0.1:8791/chats/current' },
    fetch: (input: unknown) => {
      sameOriginCalls.push(String(input))
      if (pendingFailure !== undefined) return Promise.reject(pendingFailure)
      return Promise.resolve(
        new Response('{"pkgVersion":"9.9"}', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
    },
    addEventListener: (type: string, fn: (event: unknown) => void) => {
      handlers.set(type, [...(handlers.get(type) ?? []), fn])
    },
    removeEventListener: (type: string, fn: (event: unknown) => void) => {
      handlers.set(type, (handlers.get(type) ?? []).filter(it => it !== fn))
    },
  }
  const document = {
    defaultView: view,
    createElement: () => element,
    hidden: false,
    addEventListener: (type: string, fn: (event: unknown) => void) => {
      docHandlers.set(type, [...(docHandlers.get(type) ?? []), fn])
    },
    removeEventListener: (type: string, fn: (event: unknown) => void) => {
      docHandlers.set(type, (docHandlers.get(type) ?? []).filter(it => it !== fn))
    },
  }

  const card = runCard(
    {
      bootstrapUrl: 'http://iris.test/sandbox/bootstrap-abc.js',
      scripts: [{ id: 'one', code: ';' }],
      mode: 'classic',
      libraries: [],
      documentGranted: false,
      networkGranted: false,
      bundleOrigin: 'http://127.0.0.1:8791',
      context: {} as never,
      viewport: () => ({ width: 800, height: 600 }),
      fetch: async url => {
        hostFetches.push(url)
        return 'remote bundle body'
      },
      onSettings: () => undefined,
      onSlash: async () => '',
      onDialog: () => undefined,
      // Never exercised here, and a no-op rather than an answer on purpose: a
      // popup this harness left unanswered would hang the card, which is what
      // makes an accidental one visible instead of quietly passing.
      onPopup: () => undefined,
      onPopupWithdrawn: () => undefined,
      onCall: async () => undefined,
      onError: () => undefined,
      onBlocked: () => undefined,
      onNote: message => {
        notes.push(message)
      },
      ...host,
    },
    document as unknown as Document,
  )

  return {
    card,
    fromFrame: message => {
      for (const fn of handlers.get('message') ?? []) {
        fn({ source: contentWindow, data: message })
      }
    },
    posted: () => posted,
    sameOriginCalls: () => sameOriginCalls,
    hostFetches: () => hostFetches,
    failNextRide: why => {
      pendingFailure = why
    },
    notes: () => notes,
  }
}

/** The token the runner minted, read off the srcdoc it just built. */
function tokenOf(srcdoc: string): string {
  const found = /name="iris-token" content="([0-9a-f]+)"/.exec(srcdoc)
  assert.ok(found?.[1], 'no token in the srcdoc, so no message can be addressed')
  return found[1]
}

const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))

test('a same-origin request is fetched by the shell page, not the remote route', async () => {
  const scope = harness()
  const token = tokenOf(scope.card.element.srcdoc)

  scope.fromFrame({ iris: token, type: 'fetch', id: 'f1', url: 'http://127.0.0.1:8791/version' })
  await settle()

  assert.deepEqual(scope.hostFetches(), [], 'the allowlist route was never meant for us')
  assert.deepEqual(scope.sameOriginCalls(), ['http://127.0.0.1:8791/version'])

  const answer = scope.posted().at(-1)
  assert.ok(answer?.type === 'fetch:ok')
  assert.equal(answer.id, 'f1')
  assert.equal(answer.content, '{"pkgVersion":"9.9"}')
  assert.equal(answer.status, 200, 'the card checks res.ok; the bridge must not fake it')
  assert.equal(answer.contentType, 'application/json')
})

test('a relative URL is resolved against the shell page before it is honoured', async () => {
  // The frame resolves first and sends the absolute URL; this branch is the
  // host's own double-check accepting a bare path, which is what a frame that
  // resolved against a different base would send.
  const scope = harness()
  const token = tokenOf(scope.card.element.srcdoc)

  scope.fromFrame({ iris: token, type: 'fetch', id: 'f2', url: '/version' })
  await settle()

  assert.deepEqual(scope.sameOriginCalls(), ['http://127.0.0.1:8791/version'])
  assert.deepEqual(scope.hostFetches(), [])
})

test('a foreign origin goes to the allowlisted remote route, unharmed', async () => {
  const scope = harness()
  const token = tokenOf(scope.card.element.srcdoc)

  scope.fromFrame({
    iris: token,
    type: 'fetch',
    id: 'f3',
    url: 'https://testingcf.jsdelivr.net/gh/x/bundle.js',
  })
  await settle()

  assert.deepEqual(scope.sameOriginCalls(), [], 'the shell must not proxy arbitrary hosts')
  assert.deepEqual(scope.hostFetches(), ['https://testingcf.jsdelivr.net/gh/x/bundle.js'])

  const answer = scope.posted().at(-1)
  assert.ok(answer?.type === 'fetch:ok')
  assert.equal(answer.content, 'remote bundle body')
  assert.equal(answer.status, undefined, 'the remote route never carried a status')
})

test('a neighbouring port is not our origin', async () => {
  // The main checkout runs on 8790; a frame served by 8791 must not send its
  // requests there through the bridge.
  const scope = harness()
  const token = tokenOf(scope.card.element.srcdoc)

  scope.fromFrame({ iris: token, type: 'fetch', id: 'f4', url: 'http://127.0.0.1:8790/version' })
  await settle()

  assert.deepEqual(scope.sameOriginCalls(), [])
  assert.deepEqual(scope.hostFetches(), ['http://127.0.0.1:8790/version'])
})

test('the shell refuses a same-origin path the bridge does not carry, on its own', async () => {
  /*
   * The network audit's F11, shell side — and this is the side that counts.
   * The frame consults the same list in `rideFor`, but the frame is the
   * untrusted half: a frame running an older build, or one whose check was
   * evaded, sends the message anyway, and the credentials are held here. A
   * message is delivered directly for exactly that reason, bypassing the frame.
   */
  const scope = harness()
  const token = tokenOf(scope.card.element.srcdoc)

  scope.fromFrame({ iris: token, type: 'fetch', id: 'f6', url: 'http://127.0.0.1:8791/iris/rpc' })
  await settle()

  assert.deepEqual(scope.sameOriginCalls(), [], 'the credentialed fetch never happened')
  assert.deepEqual(scope.hostFetches(), [], 'and it was not smuggled onto the remote route either')

  const answer = scope.posted().at(-1)
  assert.ok(answer?.type === 'fetch:error', 'answered on the channel the frame already understands')
  assert.equal(answer.id, 'f6')
  assert.match(answer.message as string, /\/iris\/rpc/)
  // The repo rule: a refusal names the layer that produced it.
  assert.match(answer.message as string, /the page refused to fetch it/)
  assert.deepEqual(scope.notes().length, 1, 'and it is on the durable report channel once')
})

test('the shell allows this card’s own avatar and refuses another card’s', async () => {
  const scope = harness({ context: { characterId: '络络.png' } as never })
  const token = tokenOf(scope.card.element.srcdoc)
  const own = `http://127.0.0.1:8791/iris/avatar/${encodeURIComponent('络络.png')}`
  const other = `http://127.0.0.1:8791/iris/avatar/${encodeURIComponent('爱衣.png')}`

  scope.fromFrame({ iris: token, type: 'fetch', id: 'f7', url: own })
  scope.fromFrame({ iris: token, type: 'fetch', id: 'f8', url: other })
  await settle()

  assert.deepEqual(scope.sameOriginCalls(), [own], 'the other card’s file was never read')
  const refusal = scope.posted().find(
    message => message.type === 'fetch:error' && message.id === 'f8',
  )
  assert.ok(refusal !== undefined, 'the refused one was answered')
})

test('the shell reports one refused shape once, however many cards are swept', async () => {
  const scope = harness({ context: { characterId: '络络.png' } as never })
  const token = tokenOf(scope.card.element.srcdoc)
  for (const [at, name] of ['a.png', 'b.png', 'c.png'].entries()) {
    scope.fromFrame({
      iris: token,
      type: 'fetch',
      id: `s${String(at)}`,
      url: `http://127.0.0.1:8791/iris/avatar/${encodeURIComponent(name)}`,
    })
  }
  await settle()

  assert.equal(scope.notes().length, 1, 'three refusals of one shape are one report')
  assert.equal(
    scope.posted().filter(message => message.type === 'fetch:error').length,
    3,
    'each card still got its own answer — the deduplication is the report, not the refusal',
  )
})

test('a failed same-origin fetch is reported as an error, not a body', async () => {
  const scope = harness()
  const token = tokenOf(scope.card.element.srcdoc)
  scope.failNextRide(new TypeError('network down'))

  scope.fromFrame({ iris: token, type: 'fetch', id: 'f5', url: 'http://127.0.0.1:8791/version' })
  await settle()

  const answer = scope.posted().at(-1)
  assert.ok(answer?.type === 'fetch:error' && typeof answer.message === 'string')
  assert.equal(answer.id, 'f5')
  // `posted()` records untyped bags; the message needs its type said before
  // `assert.match` will take it.
  assert.equal(typeof answer.message, 'string')
  assert.match(answer.message as string, /network down/)
})
