/**
 * The rate-limited stream display (`client/stream-display.ts`): growth waits
 * for a paint, every other change is shown at once.
 *
 * Ported from the unmerged `codex/performance-stream-ui` commit 930efd7, with
 * the transitions it did not cover (a new host-minted key without shrinking
 * text, a role change, reasoning replaced) added.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createStore } from 'zustand/vanilla'

import type { IrisStore, StreamBuffer } from '../src/client/store.ts'
import { createStreamDisplay, isStreamTransition, paintDelay } from '../src/client/stream-display.ts'

function fixture(interval = 20): {
  push: (stream: StreamBuffer | undefined) => void
  display: ReturnType<typeof createStreamDisplay>
} {
  const store = createStore<{ stream: StreamBuffer | undefined }>(() => ({ stream: undefined }))
  return {
    push: stream => store.setState({ stream }),
    display: createStreamDisplay(store as unknown as IrisStore, interval),
  }
}

const pause = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

test('a burst of deltas publishes the latest text once per interval', async () => {
  const { push, display } = fixture()
  const seen: string[] = []
  const off = display.subscribe(() => seen.push(display.getSnapshot()?.text ?? '<end>'))

  push({ turn: 0, text: '', reasoning: '' })
  for (let index = 1; index <= 80; index += 1) push({ turn: 0, text: 'x'.repeat(index), reasoning: '' })
  assert.deepEqual(seen, [''], 'the start is shown at once, the growth waits')
  await pause(40)
  assert.deepEqual(seen, ['', 'x'.repeat(80)], 'one paint carries the whole burst')
  off()
})

test('the end, an abort and a new turn publish immediately, clearing a pending paint', async () => {
  const { push, display } = fixture()
  const seen: Array<StreamBuffer | undefined> = []
  const off = display.subscribe(() => seen.push(display.getSnapshot()))

  push({ turn: 0, text: '', reasoning: '' })
  push({ turn: 0, text: 'partial', reasoning: '' })
  push(undefined)
  assert.deepEqual(seen.map(value => value?.text), ['', undefined], 'the end did not wait for the paint')

  push({ turn: 1, text: 'next', reasoning: '' })
  assert.equal(display.getSnapshot()?.text, 'next')
  await pause(40)
  assert.equal(seen.length, 3, 'the cleared paint never fires late')
  off()
})

test('a same-turn restart under a new host-minted key is shown at once', () => {
  const { push, display } = fixture()
  const seen: string[] = []
  const off = display.subscribe(() => seen.push(`${display.getSnapshot()?.key ?? '-'}:${display.getSnapshot()?.text ?? '<end>'}`))

  push({ turn: 3, key: 'old', text: 'previous reply', reasoning: '' })
  push({ turn: 3, key: 'old', text: 'previous reply plus more', reasoning: '' })
  // Not shorter: the key alone is what says this is another reply.
  push({ turn: 3, key: 'new', text: 'previous reply plus more and', reasoning: '' })
  assert.deepEqual(seen, ['old:previous reply', 'new:previous reply plus more and'])
  off()
})

test('what counts as growth', () => {
  const base: StreamBuffer = { turn: 1, key: 'k', text: 'ab', reasoning: 'r' }
  assert.equal(isStreamTransition(base, { ...base, text: 'abc' }), false)
  assert.equal(isStreamTransition(base, { ...base, reasoning: 'rr' }), false)
  assert.equal(isStreamTransition(base, { ...base, text: 'xy' }), true, 'replaced text is not growth')
  assert.equal(isStreamTransition(base, { ...base, reasoning: '' }), true, 'reasoning replaced')
  assert.equal(isStreamTransition(base, { ...base, role: 'user' }), true)
  assert.equal(isStreamTransition(base, { ...base, name: 'Someone' }), true)
  assert.equal(isStreamTransition(base, undefined), true)
  assert.equal(isStreamTransition(undefined, base), true)
  assert.equal(paintDelay({ ...base, text: 'x'.repeat(70 * 1024) }, 32), 200, 'a long reply paints less often')
  assert.equal(paintDelay(base, 32), 32)
})

test('the last listener leaving stops the timer and resynchronizes the snapshot', async () => {
  const { push, display } = fixture()
  const off = display.subscribe(() => undefined)
  push({ turn: 0, text: 'a', reasoning: '' })
  push({ turn: 0, text: 'ab', reasoning: '' })
  off()
  assert.equal(display.getSnapshot()?.text, 'ab', 'a later subscriber starts from the store, not from a stale paint')
  await pause(40)
})
