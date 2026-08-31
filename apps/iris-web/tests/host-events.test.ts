/**
 * What a card hears from the host, and what it deliberately does not.
 *
 * The risk this file guards is asymmetric. A host event that fails to reach a
 * card makes the card do nothing, which is visible. A host event that reaches a
 * card under the wrong upstream name makes the card *act* — at the wrong moment,
 * on the wrong data — and the resulting bug looks like the card's.
 *
 * @module iris-web/tests/host-events
 */
import { strict as assert } from 'node:assert'
import test from 'node:test'

import { TAVERN_EVENTS } from '@iris/compat-tavernhelper-core'
import type { ChatView, IrisEvent } from '@iris/protocol'

import { chatChangedEvent, forwardedEvents } from '../src/sandbox/host-events.ts'

/** A view is required by the event shape but never read by the mapping. */
const VIEW = {} as ChatView

test('a stream start and its tokens arrive under upstream names', () => {
  assert.deepEqual(forwardedEvents({ type: 'stream.start', chatId: 'c', turn: 0, key: 'k' }), [
    { event: TAVERN_EVENTS.GENERATION_STARTED, args: [] },
  ])
  assert.deepEqual(forwardedEvents({ type: 'stream.text', chatId: 'c', turn: 0, delta: 'hi' }), [
    { event: TAVERN_EVENTS.STREAM_TOKEN_RECEIVED, args: ['hi'] },
  ])
})

test('the end of a stream settles the message before it declares generation over', () => {
  /*
   * Order is the assertion. Cards read the text on `MESSAGE_RECEIVED` and tear
   * down on `GENERATION_ENDED`; emitting them the other way round has a card
   * releasing state one event before it reads it.
   */
  const events = forwardedEvents({ type: 'stream.end', chatId: 'c', turn: 3, view: VIEW })

  assert.deepEqual(
    events.map(forwarded => forwarded.event),
    [TAVERN_EVENTS.MESSAGE_RECEIVED, TAVERN_EVENTS.GENERATION_ENDED],
  )
  assert.deepEqual(events[0]?.args, [3], 'the turn is what identifies the message')
})

test('content updates are not announced as a chat change', () => {
  /*
   * `chat.updated` fires on every edit, including each streamed token's
   * projection. Mapping it to `CHAT_CHANGED` — which upstream fires when the
   * user opens a different chat — would have a card reloading its entire state
   * on every token.
   */
  assert.deepEqual(forwardedEvents({ type: 'chat.updated', chatId: 'c', view: VIEW }), [])
  assert.deepEqual(forwardedEvents({ type: 'chats.updated', chats: [] }), [])
})

test('a failed generation still tells the card that generation stopped', () => {
  // Otherwise a card that disables its own UI on start never re-enables it.
  assert.deepEqual(
    forwardedEvents({ type: 'stream.error', chatId: 'c', turn: 1, code: 'x', message: 'no' }),
    [{ event: TAVERN_EVENTS.GENERATION_STOPPED, args: [] }],
  )
})

test('the chat change is reported only when the chat really changed', () => {
  assert.equal(chatChangedEvent('a', 'a'), undefined, 'the same chat is not a change')
  assert.equal(chatChangedEvent(undefined, undefined), undefined)
  assert.deepEqual(chatChangedEvent('a', 'b'), {
    event: TAVERN_EVENTS.CHAT_CHANGED,
    args: ['b'],
  })
  assert.deepEqual(chatChangedEvent(undefined, 'a'), {
    event: TAVERN_EVENTS.CHAT_CHANGED,
    args: ['a'],
  })
  assert.equal(chatChangedEvent('a', undefined), undefined, 'closing a chat is not opening one')
})

test('every event the mapping produces is a name the shared table actually carries', () => {
  /*
   * The guard in the frame refuses a non-string event name, but a *string* that
   * upstream never sends would pass it. This checks the other half: that the
   * mapping only ever names entries that exist in the table both sides share.
   */
  const known = new Set(Object.values(TAVERN_EVENTS) as string[])
  const samples: IrisEvent[] = [
    { type: 'stream.start', chatId: 'c', turn: 0, key: 'k' },
    { type: 'stream.text', chatId: 'c', turn: 0, delta: 'x' },
    { type: 'stream.end', chatId: 'c', turn: 0, view: VIEW },
    { type: 'stream.error', chatId: 'c', turn: 0, code: 'x', message: 'y' },
  ]

  for (const sample of samples) {
    for (const forwarded of forwardedEvents(sample)) {
      assert.ok(known.has(forwarded.event), `${forwarded.event} is not in the shared table`)
    }
  }
  assert.ok(known.has(chatChangedEvent(undefined, 'a')?.event ?? ''))
})

test('the interception hooks are never forwarded as notifications', () => {
  /*
   * `CHAT_COMPLETION_SETTINGS_READY` is in the shared table now, which makes it
   * look forwardable. It is not. MVU's three listeners on it —
   * `applyExtraModelRequestOverrides`, `overrideToolRequest`, `filterPrompts` —
   * mutate the outgoing request and expect the host to send what they leave
   * behind. Delivering it one-way would run the card's edits and then throw them
   * away: the card succeeds, the request goes out unchanged, and nothing
   * anywhere reports a problem.
   *
   * This test exists to fail if someone adds it to the map because the name was
   * available.
   */
  const samples: IrisEvent[] = [
    { type: 'stream.start', chatId: 'c', turn: 0, key: 'k' },
    { type: 'stream.text', chatId: 'c', turn: 0, delta: 'x' },
    { type: 'stream.end', chatId: 'c', turn: 0, view: VIEW },
    { type: 'stream.error', chatId: 'c', turn: 0, code: 'x', message: 'y' },
    { type: 'chat.updated', chatId: 'c', view: VIEW },
    { type: 'chats.updated', chats: [] },
  ]
  const produced = new Set(samples.flatMap(forwardedEvents).map(forwarded => forwarded.event))

  assert.equal(produced.has(TAVERN_EVENTS.CHAT_COMPLETION_SETTINGS_READY), false)
  assert.equal(produced.has('worldinfo_entries_loaded'), false)
})

test('nothing claims a message was sent, because nothing knows yet', () => {
  // Inferring it from `stream.start` would fire on regenerate too, where
  // upstream sends no `MESSAGE_SENT`. Absent is the honest answer until the
  // shell has a real source.
  const produced = forwardedEvents({ type: 'stream.start', chatId: 'c', turn: 0, key: 'k' })

  assert.equal(
    produced.some(forwarded => forwarded.event === TAVERN_EVENTS.MESSAGE_SENT),
    false,
  )
})
