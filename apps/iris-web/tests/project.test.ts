import assert from 'node:assert/strict'
import { test } from 'node:test'

import { groupByTurn, lastReplyId, swipeTarget, withStream } from '../src/app/project.ts'
import type { ChatView, MessageView } from '@iris/protocol'

/** A settled view with one exchange. */
function view(messages: MessageView[]): ChatView {
  return { chatId: 'c1', title: 'A scene', messages }
}

const userLine: MessageView = { id: 0, key: 'u0', role: 'user', name: 'You', text: 'Go on.', turn: 1 }

test('a stream for a turn with no message yet is shown against a synthesized one', () => {
  // This is the case that decides whether a reply appears while it is being
  // written or only once it is finished: the host opens a turn with
  // `stream.start` before the client holds any message for it.
  const messages = withStream(view([userLine]), { turn: 1, text: 'She sets', reasoning: '' })

  assert.equal(messages.length, 2)
  const live = messages[1]
  assert.equal(live?.role, 'assistant')
  assert.equal(live?.text, 'She sets')
  assert.equal(live?.streaming, true)
  assert.equal(live?.turn, 1)
})

test('the synthesized row carries the identity the settled row will have', () => {
  // The invariant the whole `key` field exists for, asserted across the one
  // transition that used to break it. The host mints `m…`; this file once
  // rebuilt the key as `a${turn}`, which is the FAKE client's scheme, so the
  // two sides agreed in every test and disagreed in production: each real
  // reply was torn down and rebuilt at the instant it finished.
  const announced = 'm1'
  const live = withStream(view([userLine]), { turn: 1, text: 'She sets', reasoning: '', key: announced })

  assert.equal(live[1]?.key, announced)

  // The host then settles the turn, addressing that row by the same identity.
  const settledRow: MessageView = {
    id: 1, key: announced, role: 'assistant', name: '络络', text: 'She sets out.', turn: 1,
  }
  const settled = withStream(view([userLine, settledRow]), undefined)

  assert.equal(settled[1]?.key, live[1]?.key, 'the row keeps one identity from first token to last')
})

test('a stream whose opening frame was missed still renders', () => {
  // The reconnect case: no announced identity to be had. One remount when the
  // reopened view lands is the price, and it beats an empty chat while text
  // is visibly arriving.
  const messages = withStream(view([userLine]), { turn: 1, text: 'mid-sentence', reasoning: '' })

  assert.equal(messages.length, 2)
  assert.equal(messages[1]?.text, 'mid-sentence')
  assert.equal(typeof messages[1]?.key, 'string')
})

test('the synthesized message borrows the last speaker, not the chat title', () => {
  const earlier: MessageView = { id: 0, key: 'a0', role: 'assistant', name: '络络', text: 'Earlier.', turn: 0 }
  const messages = withStream(view([earlier, { ...userLine, id: 1 }]), {
    turn: 1,
    text: '…',
    reasoning: '',
  })

  assert.equal(messages.at(-1)?.name, '络络')
})

test('a stream for an existing message overwrites its text in place', () => {
  const placeholder: MessageView = {
    id: 1,
    key: 'a1',
    role: 'assistant',
    name: '络络',
    text: 'stale',
    turn: 1,
    swipes: { count: 2, index: 0 },
  }
  const messages = withStream(view([userLine, placeholder]), { turn: 1, text: 'fresh', reasoning: '' })

  assert.equal(messages.length, 2)
  assert.equal(messages[1]?.text, 'fresh')
  // The rail is suppressed while generating: the host's count is one behind
  // during a regenerate, and there is nothing to switch to mid-generation.
  assert.equal(messages[1]?.swipes, undefined)
})

test('an existing row keeps its own key rather than a recomputed one', () => {
  // Copying the row's key instead of rebuilding it from the host's naming
  // convention means a change to that convention cannot silently start
  // remounting streaming messages.
  const placeholder: MessageView = {
    id: 1,
    key: 'whatever-the-host-chose',
    role: 'assistant',
    name: '络络',
    text: '',
    turn: 1,
  }
  const messages = withStream(view([userLine, placeholder]), { turn: 1, text: 'fresh', reasoning: '' })

  assert.equal(messages[1]?.key, 'whatever-the-host-chose')
  assert.equal(messages[1]?.text, 'fresh')
})

test('reasoning only appears once some has arrived', () => {
  const none = withStream(view([userLine]), { turn: 1, text: 'x', reasoning: '' })
  assert.equal(none[1]?.reasoning, undefined)

  const some = withStream(view([userLine]), { turn: 1, text: 'x', reasoning: 'checking continuity' })
  assert.equal(some[1]?.reasoning, 'checking continuity')
})

test('with no stream the settled view is passed through unchanged', () => {
  const settled = view([userLine])
  assert.equal(withStream(settled, undefined), settled.messages)
})

test('messages sharing a turn become one group', () => {
  const groups = groupByTurn([
    { id: 0, key: 'a0', role: 'assistant', name: 'A', text: 'greeting', turn: 0 },
    { id: 1, key: 'u1', role: 'user', name: 'You', text: 'hi', turn: 1 },
    { id: 2, key: 'a2', role: 'assistant', name: 'A', text: 'reply', turn: 1 },
  ])

  assert.deepEqual(
    groups.map(group => [group.turn, group.messages.length]),
    [
      [0, 1],
      [1, 2],
    ],
  )
})

test('messages with no turn each stand alone', () => {
  // A rule between them would claim a grouping the host never asserted.
  const groups = groupByTurn([
    { id: 0, key: 's0', role: 'system', name: 'Iris', text: 'a' },
    { id: 1, key: 's1', role: 'system', name: 'Iris', text: 'b' },
  ])

  assert.equal(groups.length, 2)
})

test('only the last reply can be retried', () => {
  const messages: MessageView[] = [
    { id: 0, key: 'a0', role: 'assistant', name: 'A', text: 'first', turn: 0 },
    { id: 1, key: 'u1', role: 'user', name: 'You', text: 'more', turn: 1 },
    { id: 2, key: 'a2', role: 'assistant', name: 'A', text: 'second', turn: 1 },
  ]

  assert.equal(lastReplyId(messages), 2)
  assert.equal(lastReplyId([messages[1] as MessageView]), undefined)
})

test('the keyboard swipe target is the newest reply that has alternates', () => {
  const messages: MessageView[] = [
    { id: 0, key: 'a0', role: 'assistant', name: 'A', text: 'x', turn: 0, swipes: { count: 3, index: 2 } },
    { id: 1, key: 'u1', role: 'user', name: 'You', text: 'y', turn: 1 },
    { id: 2, key: 'a2', role: 'assistant', name: 'A', text: 'z', turn: 1, swipes: { count: 2, index: 1 } },
  ]

  assert.deepEqual(swipeTarget(messages), { turn: 1, count: 2, index: 1 })
  assert.equal(swipeTarget([messages[1] as MessageView]), undefined)
})
