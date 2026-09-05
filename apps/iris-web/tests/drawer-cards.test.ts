import test from 'node:test'
import assert from 'node:assert/strict'

import { isOpen, loadCardState, saveCardState, DEFAULT_OPEN_CARDS } from '../src/app/cards.ts'

/**
 * The drawer's folded cards remember their state on the device. These pins are
 * the acceptance the drawer promises: before a reader has said anything, the
 * connection and reading cards stand open and everything else is folded; a
 * toggle survives a reload; and a corrupted or foreign store reads as "no
 * opinion yet" rather than breaking the drawer.
 */

/** Run with a private in-memory `localStorage` installed as `window.localStorage`. */
function withStorage(run: () => void): void {
  const backing = new Map<string, string>()
  ;(globalThis as unknown as { window: unknown }).window = {
    localStorage: {
      getItem: (key: string) => backing.get(key) ?? null,
      setItem: (key: string, value: string) => { backing.set(key, value) },
    },
  }
  try {
    run()
  } finally {
    delete (globalThis as unknown as { window?: unknown }).window
  }
}

test('before any choice, connection and reading are open and the rest are folded', () => {
  withStorage(() => {
    const state = loadCardState()
    assert.deepEqual(Object.keys(state).length, 0)
    assert.equal(isOpen(state, 'connection'), true)
    assert.equal(isOpen(state, 'reading'), true)
    assert.equal(isOpen(state, 'sampling'), false)
    assert.equal(isOpen(state, 'worldbooks'), false)
    assert.equal(isOpen(state, 'about'), false)
    // The stated default, held to itself.
    assert.deepEqual(DEFAULT_OPEN_CARDS, ['connection', 'reading'])
  })
})

test('a toggle is remembered across a reload (a fresh load reads the store)', () => {
  withStorage(() => {
    saveCardState(loadCardState())
    const state = loadCardState()
    saveCardState({ ...state, sampling: true, connection: false })
    // Simulate the reload: a new read of the same store.
    const reloaded = loadCardState()
    assert.equal(isOpen(reloaded, 'sampling'), true)
    assert.equal(isOpen(reloaded, 'connection'), false)
    assert.equal(isOpen(reloaded, 'reading'), true, 'an unmentioned card keeps its default')
  })
})

test('a corrupted or foreign store is "no opinion yet"', () => {
  withStorage(() => {
    ;(globalThis as unknown as { window: { localStorage: { setItem: (k: string, v: string) => void } } })
      .window.localStorage.setItem('iris.drawer.cards', '{not json')
    assert.deepEqual(loadCardState(), {})

    ;(globalThis as unknown as { window: { localStorage: { setItem: (k: string, v: string) => void } } })
      .window.localStorage.setItem('iris.drawer.cards', '{"sampling": "yes", "hacker": true}')
    assert.deepEqual(loadCardState(), {}, 'non-boolean and unknown cards are not state')
  })
})
