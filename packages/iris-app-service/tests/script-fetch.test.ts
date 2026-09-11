import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { IrisEvent } from '@iris/protocol'
import type { StreamFn } from '@iris/turn'

import { ChatStore } from '../src/chats.ts'
import { AppError } from '../src/errors.ts'
import { CharacterLibrary } from '../src/library.ts'
import { DEFAULT_MAX_BYTES, MAX_HOPS, fetchAllowedRemote, type FetchLike } from '../src/remote-fetch.ts'
import { IrisAppService, type Handlers } from '../src/service.ts'
import { SettingsStore } from '../src/settings.ts'
import { fakeRemote } from './support/fake-remote.ts'

/**
 * `script.fetch` and the executor underneath it.
 *
 * The finding these exist for: the handler checked `checkScriptFetch` on the
 * URL it was given and then called a fetcher that followed redirects itself, so
 * an allow-listed host answering `302 Location: https://evil.example/x.js` lent
 * its allowance to `evil.example` — whose body came back to the card as text,
 * and a card turns text into a `blob:` URL and runs it. The body was also read
 * with no size limit at all.
 *
 * So the first test here is the **control**: the pre-change handler, written out
 * as the four lines it was, against the same transport. Without it "the redirect
 * is refused" is an assertion about code that might never have been able to
 * follow one, and the test would pass on a host that had no redirect support at
 * all. See `notes/packages/iris-app-service/DEVIATIONS.md` §69.
 */

const NOTHING: StreamFn = async function* (_options: GenerateOptions): AsyncIterable<StreamChunk> {
  yield { type: 'finish', reason: { kind: 'stop' } }
}

/** A booted service whose one interesting option is the transport. */
async function fixture(t: TestContext, fetchRemote: FetchLike): Promise<Handlers> {
  const dir = await mkdtemp(join(tmpdir(), 'iris-script-fetch-'))
  t.after(async () => { await rm(dir, { recursive: true, force: true }) })
  await mkdir(join(dir, 'characters'), { recursive: true })
  const library = new CharacterLibrary(join(dir, 'characters'), '/iris/avatar')
  return new IrisAppService({
    stream: NOTHING,
    library,
    chats: new ChatStore(join(dir, 'chats'), library),
    settings: new SettingsStore(join(dir, 'settings.json'), { provider: 'test', model: 'test-model' }),
    broadcast: (_event: IrisEvent) => {},
    fetchRemote,
  }).handlers()
}

/** The allow-listed URL a card asks for. */
const FROM = 'https://testingcf.jsdelivr.net/gh/a/b@1/bundle.js'
/** Where the far side points it, off the list. */
const OFF = 'https://evil.example/payload.js'
/** What the foreign host would have served. */
const PAYLOAD = 'globalThis.pwned = 1'

/** The refusal a call threw, as its code and message. */
async function refusalOf(work: Promise<unknown>): Promise<{ code: string, message: string }> {
  try {
    await work
  } catch (error: unknown) {
    assert.ok(error instanceof AppError, `not an AppError: ${String(error)}`)
    return { code: error.code, message: error.message }
  }
  throw new assert.AssertionError({ message: 'the call resolved instead of refusing' })
}

test('the laundered redirect: what the first-hop-only handler did, and what this one does', async (t) => {
  const routes: Record<string, { status: number, body?: string, location?: string, contentType?: string }> = {
    [FROM]: { status: 302, location: OFF, body: 'this body belongs to the redirect' },
    [OFF]: { status: 200, body: PAYLOAD, contentType: 'application/javascript' },
  }

  /*
   * **The control.** This is the handler as it stood before 2026-09-11, four
   * lines: check the allowlist on the URL that arrived, then hand it to a
   * fetcher that follows redirects. The transport below follows them the way
   * `fetch(url)` does, because that was the default.
   */
  const following = async (url: string): Promise<{ status: number, text: string }> => {
    let at = url
    for (let hop = 0; hop < 5; hop += 1) {
      const route: { status: number, body?: string, location?: string } = routes[at] ?? { status: 404 }
      if (route.status >= 300 && route.status < 400 && route.location !== undefined) {
        at = route.location
        continue
      }
      return { status: route.status, text: route.body ?? '' }
    }
    return { status: 599, text: '' }
  }
  const { checkScriptFetch } = await import('@iris/script')
  const beforeTheChange = async (url: string): Promise<string> => {
    const verdict = checkScriptFetch(url)
    if (!verdict.allowed) throw new AppError('unsupported', verdict.reason)
    const response = await following(verdict.url)
    return response.text
  }

  // The allowlist said yes to jsdelivr, and evil.example's code came back.
  assert.equal(await beforeTheChange(FROM), PAYLOAD, 'the control no longer reproduces the finding')

  // The same proposal, the same upstream, through the handler as it is now.
  const remote = fakeRemote(routes)
  const handlers = await fixture(t, remote.fetch)
  const refusal = await refusalOf(handlers['script.fetch']({ url: FROM }))

  // Named: the hop and the host it would have gone to, so a card author can
  // tell a CDN outage from a CDN pointing somewhere it should not.
  assert.equal(refusal.code, 'unsupported', 'the host declined; that is not a provider failure')
  assert.match(refusal.message, /hop 1/u, 'the refusal does not say which hop')
  assert.match(refusal.message, /evil\.example/u, 'the refusal does not name the host it refused')
  assert.match(refusal.message, /redirected to a host that is not allowed/u)

  // No body, not even in the message. A refusal that quoted what it refused
  // would hand the card the bytes by the other hand.
  assert.equal(refusal.message.includes(PAYLOAD), false, 'the refusal carried the refused body')
  assert.deepEqual(remote.asked, [FROM], 'the foreign host was contacted')
  assert.deepEqual(remote.pulled, [0], 'the redirect’s own body was read')
})

test('a redirect that stays inside the allowlist is followed and answered', async (t) => {
  // jsDelivr redirects a moving tag to its resolved version, so a host that
  // refused every redirect would refuse the ordinary case — which is why the
  // fix is per-hop checking and not "no redirects".
  const to = 'https://cdn.jsdelivr.net/npm/pkg@1.0.0/dist/b.js'
  const remote = fakeRemote({
    [FROM]: { status: 302, location: to },
    [to]: { status: 200, body: 'export const x = 1', contentType: 'application/javascript' },
  })
  const handlers = await fixture(t, remote.fetch)

  const answer = await handlers['script.fetch']({ url: FROM })

  assert.equal(answer.content, 'export const x = 1')
  assert.equal(answer.contentType, 'application/javascript')
  assert.deepEqual(remote.asked, [FROM, to])
})

test('a redirect chain longer than the limit is refused, and the next hop is not requested', async (t) => {
  // Six hops on a five-hop limit: the sixth request is made and redirects, and
  // the seventh is the one that must not happen.
  const chain = Array.from({ length: 8 }, (_, at) => `https://cdn.jsdelivr.net/npm/pkg@${String(at)}/b.js`)
  const routes: Record<string, { status: number, location?: string, body?: string }> = {}
  for (const [at, url] of chain.entries()) {
    routes[url] = at === chain.length - 1
      ? { status: 200, body: 'never reached' }
      : { status: 302, location: chain[at + 1] ?? '' }
  }
  const remote = fakeRemote(routes)
  const handlers = await fixture(t, remote.fetch)

  const refusal = await refusalOf(handlers['script.fetch']({ url: chain[0] ?? '' }))

  assert.equal(refusal.code, 'unsupported', 'the limit is this host’s, not the far side’s')
  assert.match(refusal.message, /redirected more than 5 times/u)
  assert.match(refusal.message, /the last hop was/u, 'the refusal does not say where it stopped')
  assert.equal(remote.asked.length, MAX_HOPS + 1, 'a hop past the limit was requested')
  assert.equal(remote.asked.includes(chain[6] ?? ''), false, 'the seventh hop was requested')
})

test('a body past the cap stops the read instead of being bought and discarded', async (t) => {
  // Through the handler, so the number under test is the one production uses:
  // the handler passes no cap of its own, so this asserts DEFAULT_MAX_BYTES is a
  // real cap and not a default nothing reads. 1 MiB chunks keep it to ten pulls.
  const chunk = 1_048_576
  const remote = fakeRemote(
    { [FROM]: { status: 200, body: 'x'.repeat(DEFAULT_MAX_BYTES + 2 * chunk) } },
    chunk,
  )
  const handlers = await fixture(t, remote.fetch)

  const refusal = await refusalOf(handlers['script.fetch']({ url: FROM }))

  assert.equal(refusal.code, 'unsupported')
  assert.match(refusal.message, new RegExp(`over the ${String(DEFAULT_MAX_BYTES)} byte limit`, 'u'))
  assert.match(refusal.message, /reading stopped after/u)
  // The assertion the cap exists for. A limit checked after `arrayBuffer()` has
  // already paid for every byte it was meant to refuse, which is what the old
  // handler did with `response.text()` — and it had no limit at all.
  assert.equal(remote.drained[0], false, 'the whole body was read anyway')
  assert.ok(
    (remote.pulled[0] ?? 0) <= DEFAULT_MAX_BYTES + chunk,
    `read ${String(remote.pulled[0])} bytes past a ${String(DEFAULT_MAX_BYTES)} byte cap`,
  )
})

test('the transport is told to omit credentials and never to follow a redirect', async (t) => {
  // Both travel in the init the transport receives rather than being set inside
  // the default adapter, which is how they became assertable at all: a redirect
  // the runtime follows is a hop nothing checked, and a CDN that received the
  // user's cookies would make this host a confused deputy.
  const remote = fakeRemote({ [FROM]: { status: 200, body: 'ok' } })
  const handlers = await fixture(t, remote.fetch)

  await handlers['script.fetch']({ url: FROM })

  assert.equal(remote.inits[0]?.redirect, 'manual')
  assert.equal(remote.inits[0]?.credentials, 'omit')
})

test('a plain allow-listed URL answers exactly the bytes the transport sent', async (t) => {
  /*
   * The behaviour that must not have changed. The body deliberately spans chunk
   * boundaries on a multi-byte character: the read is now incremental, and a
   * reader that decoded each chunk to a string on its own would turn 「爱衣」 into
   * replacement characters at every boundary — a corruption that a body of ASCII
   * test data would never show.
   */
  const body = `${'爱衣'.repeat(40)}//${'x'.repeat(37)}\n爱`
  const remote = fakeRemote({ [FROM]: { status: 200, body, contentType: 'text/plain; charset=utf-8' } }, 7)
  const handlers = await fixture(t, remote.fetch)

  const answer = await handlers['script.fetch']({ url: FROM })

  assert.equal(answer.content, body)
  assert.equal(answer.contentType, 'text/plain; charset=utf-8')
  assert.equal(remote.drained[0], true, 'a body under the cap was not read to the end')
})

test('a content type the far side did not send is not invented', async (t) => {
  const remote = fakeRemote({ [FROM]: { status: 200, body: 'ok' } })
  const handlers = await fixture(t, remote.fetch)

  const answer = await handlers['script.fetch']({ url: FROM })

  assert.equal(answer.content, 'ok')
  assert.equal('contentType' in answer, false, 'a content type was fabricated')
})

test('the executor refuses a foreign redirect whatever cap or hop limit it is given', async () => {
  // Straight at `fetchAllowedRemote`, because both callers are one line each
  // over it and a refusal that only held at the handler's defaults would be a
  // property of the defaults.
  const remote = fakeRemote({
    [FROM]: { status: 302, location: OFF },
    [OFF]: { status: 200, body: PAYLOAD },
  })
  const errors: string[] = []

  const result = await fetchAllowedRemote(FROM, {
    fetch: remote.fetch,
    maxBytes: 1_000_000,
    maxHops: 99,
    onError: (error: Error) => errors.push(error.message),
  })

  assert.equal(result.ok, false)
  assert.equal(result.kind, 'not-allowed')
  assert.deepEqual(remote.asked, [FROM])
  // Reported as well as returned: a host whose log is silent about a card being
  // pointed off the allowlist tells nobody it happened.
  assert.equal(errors.length, 1)
  assert.match(errors[0] ?? '', /evil\.example/u)
})

test('the executor stops a body at the exact byte, and accepts one of exactly the cap', async () => {
  const under = fakeRemote({ [FROM]: { status: 200, body: 'y'.repeat(100) } }, 16)
  const exact = await fetchAllowedRemote(FROM, { fetch: under.fetch, maxBytes: 100 })
  assert.equal(exact.ok, true, 'a body of exactly the cap was refused')
  assert.equal(exact.ok && exact.bytes.byteLength, 100)
  assert.equal(under.drained[0], true)

  const byOne = fakeRemote({ [FROM]: { status: 200, body: 'y'.repeat(101) } }, 16)
  const justOver = await fetchAllowedRemote(FROM, { fetch: byOne.fetch, maxBytes: 100 })
  assert.equal(!justOver.ok && justOver.kind, 'too-large', 'one byte over the cap was accepted')

  const over = fakeRemote({ [FROM]: { status: 200, body: 'y'.repeat(1000) } }, 16)
  const refused = await fetchAllowedRemote(FROM, { fetch: over.fetch, maxBytes: 100 })
  assert.equal(refused.ok, false)
  assert.equal(!refused.ok && refused.kind, 'too-large')
  assert.equal(over.drained[0], false, 'the read went on past the cap')
  // 1000 bytes in 16-byte chunks: the cap is passed on the seventh, so 112 bytes
  // were pulled and the remaining 888 were never transferred. A cap enforced
  // after the body has arrived would read 1000 here.
  assert.equal(over.pulled[0], 112)
})

test('an unlisted first hop still costs no request at all', async (t) => {
  // The cheapest refusal, and the one that must stay before the network:
  // fetching first would tell the foreign host that this user runs this card.
  const remote = fakeRemote({})
  const handlers = await fixture(t, remote.fetch)

  const refusal = await refusalOf(handlers['script.fetch']({ url: OFF }))

  assert.equal(refusal.code, 'unsupported')
  assert.match(refusal.message, /evil\.example is not an allowed script source/u)
  assert.deepEqual(remote.asked, [])
})

test('the far side failing is the far side’s, not a refusal', async (t) => {
  // A 404 from an allowed CDN and a blocked host are different problems, and the
  // two codes are how a caller tells them apart without reading prose.
  const remote = fakeRemote({ [FROM]: { status: 503 } })
  const handlers = await fixture(t, remote.fetch)

  const refusal = await refusalOf(handlers['script.fetch']({ url: FROM }))

  assert.equal(refusal.code, 'provider-error')
  assert.match(refusal.message, /answered 503/u)
})

test('a transport that throws is not reported as the network', async (t) => {
  const handlers = await fixture(t, () => { throw new TypeError('cannot read properties of undefined') })

  const refusal = await refusalOf(handlers['script.fetch']({ url: FROM }))

  assert.equal(refusal.code, 'provider-error')
  assert.match(refusal.message, /threw \(TypeError/u)
  assert.match(refusal.message, /fetch adapter faulted/u)
  assert.equal(refusal.message.includes('could not reach'), false, 'the message still asserts a cause')
})

test('nothing this handler fetches is written to disk', async (t) => {
  /*
   * The caching decision, pinned. Measured 2026-09-11 across both corpora: no
   * card reaches an allow-listed host through this handler at all, so there is
   * not one repeat to share — and the bundle cache holds JavaScript under a
   * seven-day TTL and a thirty-second failure memory, which is the wrong
   * behaviour for a card fetching data. Two calls, two requests.
   */
  const remote = fakeRemote({ [FROM]: { status: 200, body: 'ok' } })
  const handlers = await fixture(t, remote.fetch)

  await handlers['script.fetch']({ url: FROM })
  await handlers['script.fetch']({ url: FROM })

  assert.deepEqual(remote.asked, [FROM, FROM], 'the second call was answered from a cache')
})
