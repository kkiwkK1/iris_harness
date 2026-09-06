/**
 * The user.css slot: the store, the cap, and the mount's reversibility.
 *
 * The slot promises three things. The text and the switch persist on the
 * device (a reload finds the same sheet, still on or off as left). A sheet
 * over the size cap is refused with a `false`, never silently swapped. And
 * the mount follows the slot discipline every registration in Iris obeys:
 * install mounts, dispose unmounts, and nothing is left behind — which, with
 * no DOM in these suites, reduces to "install and dispose are safe to call,
 * repeat, and interleave".
 *
 * @module iris-web/tests/user-css
 */
import { strict as assert } from 'node:assert'
import test from 'node:test'

import {
  DEFAULT_USER_CSS,
  USER_CSS_LIMIT,
  getUserCss,
  installUserCssSlot,
  loadUserCss,
  setUserCssEnabled,
  setUserCssText,
  subscribeUserCss,
} from '../src/slots/user-css.ts'

/** Run with a private in-memory `localStorage` installed as `window.localStorage`. */
function withStorage(run: (backing: Map<string, string>) => void): void {
  const backing = new Map<string, string>()
  ;(globalThis as unknown as { window: unknown }).window = {
    localStorage: {
      getItem: (key: string) => backing.get(key) ?? null,
      setItem: (key: string, value: string) => {
        backing.set(key, value)
      },
    },
  }
  try {
    run(backing)
  } finally {
    delete (globalThis as unknown as { window?: unknown }).window
  }
}

test('an untouched slot is empty and off', () => {
  withStorage(() => {
    assert.deepEqual(getUserCss(), DEFAULT_USER_CSS)
    assert.equal(loadUserCss().enabled, false)
  })
})

test('text and switch persist, and subscribers hear each write', () => {
  withStorage(backing => {
    const seen: boolean[] = []
    const stop = subscribeUserCss(() => seen.push(getUserCss().enabled))

    assert.equal(setUserCssText('.iris-drawer { background: hotpink; }'), true)
    setUserCssEnabled(true)

    assert.equal(getUserCss().css, '.iris-drawer { background: hotpink; }')
    assert.equal(getUserCss().enabled, true)
    assert.deepEqual(seen, [false, true], 'one notification per write')

    const stored = JSON.parse(backing.get('iris.usercss') ?? 'null') as { css: string, enabled: boolean }
    assert.equal(stored.css, '.iris-drawer { background: hotpink; }')
    assert.equal(stored.enabled, true)

    // The reload half: a fresh read of the store, not the live value.
    assert.deepEqual(loadUserCss(), { css: '.iris-drawer { background: hotpink; }', enabled: true })

    stop()
    setUserCssEnabled(false)
    assert.deepEqual(seen, [false, true], 'a disposed subscription hears nothing')
    assert.equal(loadUserCss().enabled, false)
  })
})

test('switching off keeps the text — a toggle must never lose work', () => {
  withStorage(() => {
    setUserCssText('.iris-x { color: red; }')
    setUserCssEnabled(true)
    setUserCssEnabled(false)
    assert.equal(loadUserCss().css, '.iris-x { color: red; }')
    assert.equal(loadUserCss().enabled, false)
  })
})

test('a sheet over the cap is refused, and the old sheet stays', () => {
  withStorage(() => {
    setUserCssText('/* keep me */')
    assert.equal(setUserCssText('x'.repeat(USER_CSS_LIMIT + 1)), false)
    assert.equal(getUserCss().css, '/* keep me */', 'the refusal changed nothing')
  })
})

test('a corrupted store reads as the default, and an over-cap stored text clamps', () => {
  withStorage(backing => {
    backing.set('iris.usercss', '{not json')
    assert.deepEqual(loadUserCss(), DEFAULT_USER_CSS)

    backing.set('iris.usercss', JSON.stringify({ css: 'y'.repeat(USER_CSS_LIMIT + 5), enabled: true }))
    const reloaded = loadUserCss()
    assert.equal(reloaded.css.length, USER_CSS_LIMIT)
    assert.equal(reloaded.enabled, true)
  })
})

test('install and dispose are safe, repeatable, and leave nothing behind', () => {
  // No DOM in these suites — which is the point: the slot's lifetime logic
  // must not depend on one to be correct.
  assert.doesNotThrow(() => {
    const dispose = installUserCssSlot()
    const again = installUserCssSlot()
    dispose()
    again()
    dispose()
  })
  assert.doesNotThrow(() => {
    setUserCssText('.iris-y { color: blue; }')
    setUserCssEnabled(true)
    const dispose = installUserCssSlot()
    setUserCssEnabled(false)
    dispose()
  })
})
