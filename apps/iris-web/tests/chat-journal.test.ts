/**
 * Recording a card's writes to the chat array.
 *
 * @module iris-web/tests/chat-journal
 */
import { strict as assert } from 'node:assert'
import test from 'node:test'

import {
  ChatReplayError,
  recordChatEdits,
  replayChatEdits,
  type ChatEdit,
} from '../src/sandbox/chat-journal.ts'

/** A chat of plain floors. */
function floors(count: number): Record<string, unknown>[] {
  return Array.from({ length: count }, (_unused, at) => ({
    name: 'Her',
    is_user: false,
    mes: `floor ${String(at)}`,
  }))
}

/** A recorder plus what it said. */
function recorder(source: Record<string, unknown>[] = floors(3)) {
  const reports: string[] = []
  const refusals: { member: string, detail: string }[] = []
  const chat = recordChatEdits(source, {
    report: message => reports.push(message),
    refuse: (member, detail) => {
      refusals.push({ member, detail })
      throw new Error(`refused ${member}: ${detail}`)
    },
  })
  return { chat, reports, refusals }
}

test('a push is journalled and visible to the card that made it', () => {
  /*
   * Both halves. Journalling without applying would make a card read back a chat
   * missing the message it just added — upstream's live array gives it that for
   * free, and constraint 4 says reads must not regress.
   */
  const { chat } = recorder()
  chat.array.push({ name: 'Her', is_user: false, mes: 'a new floor' })

  assert.deepEqual(chat.entries(), [
    { kind: 'append', message: { name: 'Her', is_user: false, mes: 'a new floor' } },
  ])
  assert.equal(chat.array.length, 4)
  assert.equal(chat.array[3]?.['mes'], 'a new floor')
})

test('an in-place rewrite is seen, which an array-level proxy alone cannot do', () => {
  /*
   * `chat[i].mes = x` mutates the **message object**, not the array. This is the
   * detail most easily dropped as a refinement, and dropping it restores the
   * silent loss for one of the three measured mutations while looking fixed.
   */
  const { chat } = recorder()
  const floor = chat.array[1]
  assert.ok(floor !== undefined)
  floor['mes'] = 'rewritten'

  assert.deepEqual(chat.entries(), [{ kind: 'rewrite', index: 1, text: 'rewritten' }])
  assert.equal(chat.array[1]?.['mes'], 'rewritten')
})

test('a splice is journalled at the index the array had when it happened', () => {
  const { chat } = recorder()
  chat.array.splice(1, 1)

  assert.deepEqual(chat.entries(), [{ kind: 'remove', index: 1 }])
  assert.deepEqual(chat.array.map(entry => entry['mes']), ['floor 0', 'floor 2'])
})

test('the journal keeps the order the card worked in, back to front included', () => {
  /*
   * The measured shape, from `魔法少女的扣扣审判`: it sorts its work
   * `(a, b) => b.index - a.index` — back to front, commented "avoid index shift"
   * — and mixes splices with rewrites in one loop, saving once at the end.
   *
   * So each index is relative to the array **as the earlier operations in the
   * same batch have already left it**. Reordering, sorting or deduplicating the
   * journal on the way out deletes different floors, silently, and it breaks the
   * card's own discipline first — the discipline that exists to make sequential
   * indices correct.
   */
  const { chat } = recorder(floors(5))

  // Back to front, exactly as the card does it.
  const second = chat.array[3]
  assert.ok(second !== undefined)
  second['mes'] = 'edited 3'
  chat.array.splice(2, 1)
  const first = chat.array[0]
  assert.ok(first !== undefined)
  first['mes'] = 'edited 0'

  assert.deepEqual(chat.entries(), [
    { kind: 'rewrite', index: 3, text: 'edited 3' },
    { kind: 'remove', index: 2 },
    { kind: 'rewrite', index: 0, text: 'edited 0' },
  ])

  // And the working copy agrees with what replaying that sequence would produce.
  assert.deepEqual(chat.array.map(entry => entry['mes']), [
    'edited 0',
    'floor 1',
    'edited 3',
    'floor 4',
  ])
})

test('sorting the journal would delete a different floor', () => {
  /*
   * The reason the ordering test above is not merely descriptive. This is what
   * "replay by index" produces if anyone reads it as permission to reorder.
   */
  const entries: ChatEdit[] = [
    { kind: 'remove', index: 3 },
    { kind: 'remove', index: 1 },
  ]
  const asRecorded = ['a', 'b', 'c', 'd', 'e']
  for (const edit of entries) if (edit.kind === 'remove') asRecorded.splice(edit.index, 1)

  const sorted = [...entries].sort((left, right) =>
    (left.kind === 'remove' ? left.index : 0) - (right.kind === 'remove' ? right.index : 0))
  const reordered = ['a', 'b', 'c', 'd', 'e']
  for (const edit of sorted) if (edit.kind === 'remove') reordered.splice(edit.index, 1)

  assert.deepEqual(asRecorded, ['a', 'c', 'e'])
  assert.deepEqual(reordered, ['a', 'c', 'd'], 'sorting changes which floors survive')
  assert.notDeepEqual(asRecorded, reordered)
})

test('fields the host cannot store are dropped with a report, not quietly', () => {
  const { chat, reports } = recorder()
  chat.array.push({ name: 'Her', mes: 'hi', swipes: ['hi'], invented_by_card: 1 })

  const entry = chat.entries()[0]
  assert.ok(entry?.kind === 'append')
  assert.deepEqual(entry.message, { name: 'Her', mes: 'hi' })
  assert.ok(
    reports.some(line => line.includes('swipes') && line.includes('invented_by_card')),
    'the dropped fields went unmentioned',
  )
})

test('a mutation with no counterpart is refused by name, not silently kept', () => {
  /*
   * Constraint 1: no third state. A `sort()` left alone would reorder the
   * working copy, the card would read its new order back, and `saveChat` would
   * store the old one — the exact failure this module exists to end, reproduced
   * one method along.
   */
  for (const method of ['pop', 'shift', 'unshift', 'sort', 'reverse']) {
    const { chat, refusals } = recorder()
    assert.throws(
      () => (chat.array as unknown as Record<string, () => unknown>)[method]?.(),
      /refused chat\./u,
      `${method} was allowed through`,
    )
    assert.equal(refusals[0]?.member, `chat.${method}`)
  }
})

test('assigning a floor or a length is refused too', () => {
  // Neither goes through a method, so neither would reach the traps above.
  const { chat } = recorder()
  assert.throws(() => {
    chat.array[0] = { mes: 'replaced' }
  }, /refused chat\[index\]/u)

  assert.throws(() => {
    chat.array.length = 0
  }, /refused chat\.length/u)
})

test('a splice shape the journal cannot describe is refused rather than guessed', () => {
  const { chat } = recorder()
  assert.throws(() => chat.array.splice(1, 2), /refused chat\.splice/u)
  assert.throws(() => chat.array.splice(1, 0, { mes: 'inserted' }), /refused chat\.splice/u)
})

test('the source array is never touched', () => {
  // The snapshot belongs to the frame and is shared with everything else reading
  // it; the card works on a copy until its journal is replayed.
  const source = floors(2)
  const { chat } = recorder(source)
  chat.array.push({ mes: 'new' })
  const floor = chat.array[0]
  assert.ok(floor !== undefined)
  floor['mes'] = 'changed'

  assert.equal(source.length, 2)
  assert.equal(source[0]?.['mes'], 'floor 0')
})

test('clearing forgets the journal but keeps the array', () => {
  const { chat } = recorder()
  chat.array.push({ mes: 'new' })
  chat.clear()

  assert.deepEqual(chat.entries(), [])
  assert.equal(chat.array.length, 4, 'clearing the journal must not undo the card’s work')
})

test('reads pass through untouched', () => {
  // Constraint 4. Everything a card does that is not a mutation must behave as
  // the plain array did.
  const { chat } = recorder()
  assert.equal(chat.array.length, 3)
  assert.equal(chat.array[0]?.['mes'], 'floor 0')
  assert.deepEqual(chat.array.map(entry => entry['mes']), ['floor 0', 'floor 1', 'floor 2'])
  assert.equal(chat.array.filter(entry => entry['is_user'] === false).length, 3)
  assert.deepEqual(chat.entries(), [], 'a read journalled something')
})

/** A replay target recording calls, optionally failing at the nth. */
function host(failAt?: number) {
  const calls: { method: string, params: Record<string, unknown> }[] = []
  return {
    calls,
    env: {
      call: async (method: string, params: Record<string, unknown>) => {
        calls.push({ method, params })
        if (failAt !== undefined && calls.length === failAt) throw new Error('host said no')
        return undefined
      },
    },
  }
}

test('the three kinds route to the three arms, then one commit', async () => {
  const target = host()
  await replayChatEdits(
    [
      { kind: 'append', message: { name: 'Her', is_user: false, mes: 'new' } },
      { kind: 'remove', index: 2 },
      { kind: 'rewrite', index: 0, text: 'edited' },
    ],
    target.env,
  )

  assert.deepEqual(target.calls.map(one => one.method), [
    'createChatMessages',
    'deleteChatMessages',
    'setChatMessages',
    'saveChat',
  ])
})

test('a rewrite goes through setChatMessages and nowhere else', async () => {
  /*
   * A floor's text lives in its swipe list, so an edit that misses the list is
   * undone by the next swipe back and forth. That rule has been implemented
   * correctly once in this repo, and routing rewrites anywhere else would be the
   * second implementation.
   */
  const target = host()
  await replayChatEdits([{ kind: 'rewrite', index: 4, text: 'x' }], target.env)

  assert.deepEqual(target.calls[0], {
    method: 'setChatMessages',
    params: { messages: [{ messageId: 4, message: 'x' }] },
  })
})

test('deletes go one id per call, never collected into one', async () => {
  /*
   * The tidy-up this forbids. These indices were recorded against successive
   * states; the batch arm applies its ids against one. One id per call makes the
   * two readings coincide — collecting them makes them differ, silently.
   */
  const target = host()
  await replayChatEdits(
    [{ kind: 'remove', index: 3 }, { kind: 'remove', index: 1 }],
    target.env,
  )

  const deletes = target.calls.filter(one => one.method === 'deleteChatMessages')
  assert.equal(deletes.length, 2, 'the deletes were collected into one call')
  assert.deepEqual(deletes.map(one => one.params['messageIds']), [[3], [1]])
})

test('nothing is committed until every entry has landed', async () => {
  const target = host()
  await replayChatEdits(
    [{ kind: 'append', message: { mes: 'a' } }, { kind: 'append', message: { mes: 'b' } }],
    target.env,
  )

  const saveAt = target.calls.findIndex(one => one.method === 'saveChat')
  assert.equal(saveAt, target.calls.length - 1, 'the commit must be last')
  assert.equal(target.calls.filter(one => one.method === 'saveChat').length, 1)
})

test('a failure says how many entries landed, not just that it failed', async () => {
  /*
   * The contract that replaced "nothing persists until save". That was a means,
   * and it cannot cover this: the third entry can fail after two are in the host.
   * A bare rejection leaves the card unable to tell which world it is in — it
   * cannot recover and cannot report usefully. So the rejection carries the count.
   */
  const target = host(3)
  const entries: ChatEdit[] = [
    { kind: 'append', message: { mes: 'a' } },
    { kind: 'append', message: { mes: 'b' } },
    { kind: 'remove', index: 1 },
  ]

  await assert.rejects(replayChatEdits(entries, target.env), (error: unknown) => {
    assert.ok(error instanceof ChatReplayError)
    assert.equal(error.applied, 2)
    assert.equal(error.total, 3)
    assert.equal(error.entry.kind, 'remove')
    assert.match(error.message, /2 earlier change\(s\) are in the host and were not saved/u)
    return true
  })

  assert.equal(
    target.calls.some(one => one.method === 'saveChat'),
    false,
    'a failed batch must not commit',
  )
})

test('a commit that fails is reported as a commit failure, with everything applied', async () => {
  // The case the deferred-commit design cannot prevent: every entry landed and
  // the save itself failed. The card must learn that the host holds all of it.
  const target = host(2)
  await assert.rejects(
    replayChatEdits([{ kind: 'rewrite', index: 0, text: 'x' }], target.env),
    (error: unknown) => {
      assert.ok(error instanceof ChatReplayError)
      assert.equal(error.applied, 1)
      assert.equal(error.total, 1)
      return true
    },
  )
})

test('an empty journal does not touch the host at all', async () => {
  // Including the commit: a card that called saveChat having changed nothing
  // should not cause a write.
  const target = host()
  await replayChatEdits([], target.env)
  assert.deepEqual(target.calls, [])
})
