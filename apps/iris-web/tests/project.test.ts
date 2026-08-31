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

test('the streaming row carries the key its settled row will have', () => {
  // This is what makes a finished reply update its row in place. If the keys
  // differed, React would unmount the half-written message and mount the
  // finished one next to it — visible as a flicker, and it would discard any
  // local state on that row.
  const synthesized = withStream(view([userLine]), { turn: 1, text: 'x', reasoning: '' })
  assert.equal(synthesized.at(-1)?.key, 'a1')
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
