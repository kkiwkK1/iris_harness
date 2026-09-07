import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { listCandidates } from '@iris/chat'
import type { Contribution } from '@iris/pipeline'

import { historyFromSession, TurnDriver, TurnError } from '../src/index.ts'

/** A stream that emits `text` and completes, recording the request it saw. */
function scriptedStream(replies: string[]) {
  const seen: GenerateOptions[] = []
  let call = 0
  const stream = async function* (options: GenerateOptions): AsyncIterable<StreamChunk> {
    seen.push(options)
    const text = replies[Math.min(call, replies.length - 1)] as string
    call += 1
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  return { stream, seen }
}

/** A stream that fails the way a provider does — with a terminal finish, not a throw. */
async function* failingStream(): AsyncIterable<StreamChunk> {
  yield { type: 'finish', reason: { kind: 'error', failure: { message: 'upstream refused', code: 'TRANSPORT' } } }
}

const CONTRIBUTIONS: Contribution[] = [
  { id: 'persona', placement: { kind: 'system', order: 0 }, text: 'You are Aria.' },
  { id: 'jailbreak', placement: { kind: 'depth', depth: 0, role: 'system' }, text: 'Stay in character.' },
]

/**
 * A driver over a fresh log.
 *
 * `forwardProjection` chooses which of the two shapes a `history` callback can
 * have. The default is the one every call site in this repository is actually
 * written in — `session => historyFromSession(session)`, which cannot honour a
 * projection at all — so a test gets the driver's own enforcement unless it
 * asks for the forwarding shape.
 */
function harness(replies: string[], options: { forwardProjection?: boolean } = {}) {
  const scripted = scriptedStream(replies)
  const driver = new TurnDriver({
    stream: scripted.stream,
    provider: 'test',
    model: 'test-model',
    contributions: () => CONTRIBUTIONS,
    history: options.forwardProjection === true
      ? (session, projection) => historyFromSession(session, projection)
      : session => historyFromSession(session),
    budget: { context: 10_000, reserve: 0, count: text => text.length },
  })
  return { driver, session: Session.create(SessionId(`turn-${Math.random().toString(36).slice(2)}`)), seen: scripted.seen }
}

/** Text of a candidate. */
function textOf(candidate: { message: { content: readonly { type: string, text?: string }[] } }): string {
  return candidate.message.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

test('send opens a turn, streams a reply and records it', async () => {
  const { driver, session } = harness(['Hello, traveller.'])

  const candidate = await driver.send(session, 'Hello?')

  assert.equal(textOf(candidate), 'Hello, traveller.')
  assert.equal(listCandidates(session, 0).length, 1)
  assert.equal(session.events.some(event => event.type === 'turn/end'), true)
})

test('the assembled request carries the system prompt and the depth injection', async () => {
  const { driver, session, seen } = harness(['ok'])
  await driver.send(session, 'Hello?')

  const request = seen[0]
  assert.equal(request?.system, 'You are Aria.')
  const texts = request?.messages.map(message =>
    message.content.filter(block => block.type === 'text').map(block => block.text).join('')) ?? []
  assert.deepEqual(texts, ['Hello?', 'Stay in character.'], 'the post-history instruction is last')
})

test('raw chunks are logged for replay', async () => {
  const { driver, session } = harness(['Hi.'])
  await driver.send(session, 'Hello?')

  assert.equal(session.events.filter(event => event.type === 'assistant/chunk').length, 4)
})

test('streaming callbacks see the deltas as they arrive', async () => {
  const { driver, session } = harness(['Hello, traveller.'])
  let streamed = ''

  await driver.send(session, 'Hello?', { onText: delta => { streamed += delta } })

  assert.equal(streamed, 'Hello, traveller.')
})

test('regenerating adds a candidate to the same turn, not a new turn', async () => {
  const { driver, session } = harness(['First.', 'Second.'])
  await driver.send(session, 'Hello?')

  const second = await driver.regenerate(session)

  assert.equal(textOf(second), 'Second.')
  const { candidates, selected } = driver.swipes(session, 0)
  assert.equal(candidates.length, 2)
  assert.equal(selected, 1)
  assert.equal(session.events.filter(event => event.type === 'turn/start').length, 1)
})

test('swiping back changes what the next turn is built on', async () => {
  const { driver, session, seen } = harness(['First.', 'Second.', 'Third.'])
  await driver.send(session, 'Hello?')
  await driver.regenerate(session)
  driver.swipe(session, 0, 0)

  await driver.send(session, 'And then?')

  const texts = seen[2]?.messages.map(message =>
    message.content.filter(block => block.type === 'text').map(block => block.text).join('')) ?? []
  assert.deepEqual(texts, ['Hello?', 'First.', 'And then?', 'Stay in character.'])
})

test('a failed generation keeps the user message so the turn can be retried', async () => {
  const driver = new TurnDriver({
    stream: failingStream,
    provider: 'test',
    model: 'test-model',
    contributions: () => CONTRIBUTIONS,
    history: session => historyFromSession(session),
    budget: { context: 10_000, reserve: 0, count: text => text.length },
  })
  const session = Session.create(SessionId('turn-failure'))

  await assert.rejects(() => driver.send(session, 'Hello?'), TurnError)

  assert.equal(session.events.some(event => event.type === 'user/message'), true)
  assert.equal(session.events.some(event => event.type === 'turn/end'), false, 'the turn stays open for a retry')
})

test('regenerating an empty log is refused', async () => {
  const { driver, session } = harness(['x'])

  await assert.rejects(() => driver.regenerate(session), TurnError)
})

test('history pins the opening message against trimming', async () => {
  const { driver, session } = harness(['Hi.'])
  await driver.send(session, 'Hello?')

  assert.equal(historyFromSession(session)[0]?.pinned, true)
})

test('continueTurn rejoins the continued reading and keeps its siblings', async () => {
  const { driver, session, seen } = harness([' first act.', ' and more.'])
  await driver.send(session, 'begin')

  const candidate = await driver.continueTurn(session, {}, 'carry the scene on')

  // The recorded candidate is the JOINED text, and it is a second reading of
  // the same turn — the first one stays swipable, which is what SillyTavern's
  // in-place continue would have overwritten.
  assert.equal(textOf(candidate), ' first act. and more.')
  assert.equal(listCandidates(session, 0).length, 2)
  assert.equal(session.events.some(event => event.type === 'turn/start' && event.data.turn === 1), false)

  // The nudge is the request's LAST message — after the depth-0 injection,
  // which is where depth 0 lands by convention.
  const texts = seen[1]?.messages.map(message =>
    message.content.filter(block => block.type === 'text').map(block => block.text).join('')) ?? []
  assert.equal(texts.at(-1), 'carry the scene on')
})

test('continueTurn without a nudge still closes on the conversation', async () => {
  const { driver, session } = harness([' first act.', ' and more.'])
  await driver.send(session, 'begin')

  const candidate = await driver.continueTurn(session)
  assert.equal(textOf(candidate), ' first act. and more.')
})

test('continueTurn refuses a log whose newest turn has no reply', async () => {
  const { driver, session } = harness(['unused'])
  await assert.rejects(() => driver.continueTurn(session), TurnError)
})

test('impersonate records a user line, no reply, and the instruction last', async () => {
  const { driver, session, seen } = harness(['The maps are in the vault.', 'I will look for it myself.'])
  await driver.send(session, 'Where are the maps?')

  const text = await driver.impersonate(session, {}, 'write as the traveller')

  const texts = seen[1]?.messages.map(message =>
    message.content.filter(block => block.type === 'text').map(block => block.text).join('')) ?? []
  // The line being written was not part of its own context, and the
  // instruction closed the request.
  assert.equal(texts.includes('I will look for it myself.'), false, 'the generated line was in its own context')
  assert.equal(texts.at(-1), 'write as the traveller')

  // It settled as a user line opening its own turn, with no reply after it.
  assert.equal(text, 'I will look for it myself.')
  const userLine = session.events.filter(event => event.type === 'user/message').at(-1)
  const reply = session.events.filter(event => event.type === 'assistant/message').at(-1)
  assert.notEqual(userLine, undefined)
  assert.notEqual(reply, undefined)
  // The impersonated line is the NEWEST message: the only assistant/message on
  // the log is the earlier turn's reply.
  assert.equal(
    (reply?.seq ?? Number.NEGATIVE_INFINITY) < (userLine?.seq ?? 0),
    true,
    'the impersonated line is the newest message on the log',
  )

  // The next send opens the turn AFTER the impersonated one.
  await driver.send(session, 'Thanks.')
  assert.equal(session.events.some(event => event.type === 'turn/start' && event.data.turn === 2), true)
})

test('a continue carries its separator on the request, not only on the composite', async () => {
  const { driver, session, seen } = harness(['A reply.', ' And more.'])
  await driver.send(session, 'begin')

  const candidate = await driver.continueTurn(session, {}, 'carry on', '\n\n')

  // The provider reads the same boundary it is expected to write from — the
  // continued floor's text in the request carries the separator, exactly the
  // way upstream appends `continue_postfix` to `cyclePrompt` (script.js:4919).
  const texts = seen[1]?.messages.map(message =>
    message.content.filter(block => block.type === 'text').map(block => block.text).join('')) ?? []
  assert.equal(texts.includes('A reply.\n\n'), true, 'the request never carried the continue separator')
  // The nudge still closes the request, after the separator.
  assert.equal(texts.at(-1), 'carry on')
  // And the recorded composite joins seed, separator, continuation.
  assert.equal(textOf(candidate), 'A reply.\n\n And more.')
})

test('a seed already ending in a space takes no separator, so a space postfix cannot stack', async () => {
  const { driver, session, seen } = harness(['A reply. ', ' And more.'])
  await driver.send(session, 'begin')

  const candidate = await driver.continueTurn(session, {}, undefined, ' ')

  const texts = seen[1]?.messages.map(message =>
    message.content.filter(block => block.type === 'text').map(block => block.text).join('')) ?? []
  assert.equal(texts.includes('A reply. '), true, 'the trailing space was not left alone')
  assert.equal(textOf(candidate), 'A reply.  And more.')
})

test('squashSystemMessages merges adjacent system messages and leaves the tail alone', async () => {
  // Two depth-0 injections ride beside each other with the same role: exactly
  // the shape a provider that takes repeated injected messages badly chokes on.
  const injections: Contribution[] = [
    { id: 'persona', placement: { kind: 'system', order: 0 }, text: 'You are Aria.' },
    { id: 'injA', placement: { kind: 'depth', depth: 0, role: 'system' }, text: 'Injection A.' },
    { id: 'injB', placement: { kind: 'depth', depth: 0, role: 'system' }, text: 'Injection B.' },
  ]
  const build = (squash: boolean) => {
    const scripted = scriptedStream(['unused'])
    const driver = new TurnDriver({
      stream: scripted.stream,
      provider: 'test',
      model: 'test-model',
      contributions: () => injections,
      history: session => historyFromSession(session),
      budget: { context: 10_000, reserve: 0, count: text => text.length },
      ...squash ? { squashSystemMessages: true } : {},
    })
    return { driver, seen: scripted.seen, session: Session.create(SessionId(`squash-${String(squash)}`)) }
  }

  // Off (the default): the request rides exactly as it was assembled. The two
  // injections are adjacent, which is the run the squash collapses.
  const off = build(false)
  await off.driver.send(off.session, 'Hello?')
  const baseline = off.seen[0]?.messages.map(message =>
    message.content.filter(block => block.type === 'text').map(block => block.text).join('')) ?? []
  assert.equal(baseline.at(-2), 'Injection A.')
  assert.equal(baseline.at(-1), 'Injection B.')

  // On: adjacent system messages merge, joining with a blank line; nothing
  // else about the conversation's shape changes.
  const on = build(true)
  await on.driver.send(on.session, 'Hello?')
  const texts = on.seen[0]?.messages.map(message =>
    message.content.filter(block => block.type === 'text').map(block => block.text).join('')) ?? []
  assert.deepEqual(texts, [...baseline.slice(0, -2), 'Injection A.\n\nInjection B.'])

  // A continue's nudge is exempt: it stays the request's LAST message, its own
  // message, even when it follows a merged run.
  await on.driver.send(on.session, 'And then?')
  await on.driver.continueTurn(on.session, {}, 'carry the scene on')
  const continued = on.seen[2]?.messages.map(message =>
    message.content.filter(block => block.type === 'text').map(block => block.text).join('')) ?? []
  assert.equal(continued.at(-1), 'carry the scene on')
})

test('a reroll does not show the model the reply it is replacing', async () => {
  const { driver, session, seen } = harness(['First.', 'Second.'])
  await driver.send(session, 'Hello?')

  await driver.regenerate(session)

  // Upstream deletes the message before the prompt is built on a regenerate
  // (`chat.length = chat.length - 1`, script.js:4347) and pops it from the
  // prompt copy on a swipe (`coreChat.pop()`, :4438-4440). Either way the
  // conversation the model reads ends at the user's line — a model shown its
  // own previous answer and asked for another one repeats it or argues with it.
  const texts = seen[1]?.messages.map(message =>
    message.content.filter(block => block.type === 'text').map(block => block.text).join('')) ?? []
  assert.equal(texts.includes('First.'), false, 'the reply being replaced was fed back to the model')
  assert.deepEqual(texts, ['Hello?', 'Stay in character.'])
})

test('the reply a reroll leaves out is still a candidate, with its records intact', async () => {
  const { driver, session } = harness(['First.', 'Second.'])
  await driver.send(session, 'Hello?')

  await driver.regenerate(session)

  // Leaving the reply out of the PROMPT is not deleting it. Upstream's
  // regenerate really does splice it off `chat`; here it stays a swipe, which
  // is what keeps its `iris_usage` row and its variable table addressable by
  // candidate — the whole reason swipes are candidates in this log.
  const { candidates, selected } = driver.swipes(session, 0)
  assert.deepEqual(candidates.map(textOf), ['First.', 'Second.'])
  assert.equal(selected, 1)
})

test('an ordinary send still carries the whole conversation', async () => {
  const { driver, session, seen } = harness(['First.', 'Second.'])
  await driver.send(session, 'Hello?')

  await driver.send(session, 'And then?')

  const texts = seen[1]?.messages.map(message =>
    message.content.filter(block => block.type === 'text').map(block => block.text).join('')) ?? []
  assert.deepEqual(texts, ['Hello?', 'First.', 'And then?', 'Stay in character.'])
})

test('a retry after a failed reply drops nothing, because there is no reply to drop', async () => {
  // Upstream's own guard: `if (chat.length && lastMessage.is_user)` does
  // nothing, so a turn whose first attempt never landed keeps its user line.
  const scripted = scriptedStream(['A reply.'])
  let fail = true
  const driver = new TurnDriver({
    stream: options => (fail
      ? (async function* () {
        fail = false
        yield { type: 'finish' as const, reason: { kind: 'error' as const, failure: { message: 'refused', code: 'TRANSPORT' } } }
      })()
      : scripted.stream(options)),
    provider: 'test',
    model: 'test-model',
    contributions: () => CONTRIBUTIONS,
    history: session => historyFromSession(session),
    budget: { context: 10_000, reserve: 0, count: text => text.length },
  })
  const session = Session.create(SessionId('turn-retry-drop'))

  await assert.rejects(() => driver.send(session, 'Hello?'), TurnError)
  const candidate = await driver.retry(session)

  assert.equal(textOf(candidate), 'A reply.')
  const texts = scripted.seen[0]?.messages.map(message =>
    message.content.filter(block => block.type === 'text').map(block => block.text).join('')) ?? []
  assert.deepEqual(texts, ['Hello?', 'Stay in character.'], 'the retry lost the user line it was retrying')
})

test('a history callback that honours the projection is not popped a second time', async () => {
  const { driver, session, seen } = harness(['First.', 'Second.', 'Third.'], { forwardProjection: true })
  await driver.send(session, 'Hello?')
  await driver.send(session, 'And then?')

  await driver.regenerate(session)

  // The enforcement in the driver is a repair for callbacks that cannot honour
  // the projection, and a repair that ran twice would eat the previous turn's
  // reply as well — which is exactly the failure a "pop the trailing assistant
  // entry" check would produce here.
  const texts = seen[2]?.messages.map(message =>
    message.content.filter(block => block.type === 'text').map(block => block.text).join('')) ?? []
  assert.deepEqual(texts, ['Hello?', 'First.', 'And then?', 'Stay in character.'])
})

test('a continue still sees the reading it is continuing', async () => {
  const { driver, session, seen } = harness([' first act.', ' and more.'], { forwardProjection: true })
  await driver.send(session, 'begin')

  await driver.continueTurn(session, {}, 'carry the scene on')

  // The projection belongs to a reroll only. A continue writes ON from the
  // newest reply — dropping it would turn the request into a bare reroll that
  // happens to carry a continue nudge.
  const texts = seen[1]?.messages.map(message =>
    message.content.filter(block => block.type === 'text').map(block => block.text).join('')) ?? []
  assert.equal(texts.includes(' first act.'), true, 'the continue lost the reading it was continuing')
})

test('historyFromSession drops the trailing reply only when asked, and only a reply', async () => {
  const { driver, session } = harness(['First.'])
  await driver.send(session, 'Hello?')

  assert.deepEqual(
    historyFromSession(session).map(entry => entry.text),
    ['Hello?', 'First.'],
  )
  assert.deepEqual(
    historyFromSession(session, { dropTrailingReply: true }).map(entry => entry.text),
    ['Hello?'],
  )
  // The pin follows the projection: it is index 0 of what is being sent.
  assert.equal(historyFromSession(session, { dropTrailingReply: true })[0]?.pinned, true)
})
