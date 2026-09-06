/**
 * The theme choice store: instant, persistent, tolerant.
 *
 * The acceptance this pins: a choice made in the drawer is the choice the
 * module reports **now** (the switch must not wait for a reload), the same
 * choice is what a fresh read of the store finds (it must survive one), the
 * default is "follow the system" until the reader names a theme, and a store
 * holding anything else reads as "no opinion yet" rather than as a broken
 * page.
 *
 * @module iris-web/tests/theme-choice
 */
import { strict as assert } from 'node:assert'
import test from 'node:test'

import {
  getThemeChoice,
  loadThemeChoice,
  loadThemeOverrides,
  resolveThemeId,
  setThemeChoice,
  setThemeOverrides,
  subscribeTheme,
} from '../src/theme/theme.ts'

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

test('the default choice is the system, not a named theme', () => {
  withStorage(() => {
    assert.equal(getThemeChoice(), 'system', 'the module starts where the reader left nothing')
    assert.equal(loadThemeChoice(), 'system')
  })
})

test('a choice takes effect immediately, is stored, and is announced', () => {
  withStorage(backing => {
    const seen: string[] = []
    const stop = subscribeTheme(() => seen.push(getThemeChoice()))

    setThemeChoice('parchment')

    assert.equal(getThemeChoice(), 'parchment', 'the live value moved at once')
    assert.equal(backing.get('iris.theme'), 'parchment', 'the store carries it for the next load')
    assert.deepEqual(seen, ['parchment'], 'subscribers heard exactly one switch')

    // The same choice again is not a switch: no re-apply, no re-announce.
    setThemeChoice('parchment')
    assert.deepEqual(seen, ['parchment'])

    stop()
    setThemeChoice('light')
    assert.deepEqual(seen, ['parchment'], 'a disposed subscription hears nothing')
  })
})

test('a fresh read of the store is the reload half of the promise', () => {
  withStorage(backing => {
    setThemeChoice('dark')
    // `loadThemeChoice` reads the store, not the module's live value — the
    // same path a reload takes.
    assert.equal(loadThemeChoice(), 'dark')
    assert.equal(backing.get('iris.theme'), 'dark')
  })
})

test('a foreign or unknown stored word reads as follow-the-system', () => {
  withStorage(backing => {
    backing.set('iris.theme', 'plaid')
    assert.equal(loadThemeChoice(), 'system')
    backing.set('iris.theme', '')
    assert.equal(loadThemeChoice(), 'system')
  })
})

test('a named theme resolves to itself; the system resolves where there is no OS to ask', () => {
  withStorage(() => {
    // The fake window has no matchMedia, which is also the node case: the
    // media query cannot be asked, so light is the answer that cannot lie.
    assert.equal(resolveThemeId('system'), 'light')
    assert.equal(resolveThemeId('dark'), 'dark')
    assert.equal(resolveThemeId('parchment'), 'parchment')
  })
})

test('the overrides layer keeps only bounded palette overrides', () => {
  withStorage(backing => {
    assert.deepEqual(loadThemeOverrides(), {}, 'no layer until one is written')

    setThemeOverrides({ '--iris-accent': '#112233', '--iris-not-a-token': 'x', '--iris-warn': 42 as never })
    assert.deepEqual(loadThemeOverrides(), { '--iris-accent': '#112233' },
      'unknown property names and non-string values are not a palette')

    const stored = JSON.parse(backing.get('iris.theme.overrides') ?? 'null') as Record<string, string>
    assert.deepEqual(stored, { '--iris-accent': '#112233' })

    // An empty table is the "clear" command, and it clears the store too.
    setThemeOverrides({})
    assert.deepEqual(loadThemeOverrides(), {})
    assert.deepEqual(JSON.parse(backing.get('iris.theme.overrides') ?? 'null'), {})
  })
})

test('a corrupted or over-full overrides table reads as none', () => {
  withStorage(backing => {
    backing.set('iris.theme.overrides', '{not json')
    assert.deepEqual(loadThemeOverrides(), {})

    const flood: Record<string, string> = {}
    for (let at = 0; at < 100; at += 1) flood[`--iris-accent-${String(at)}`] = '#000000'
    backing.set('iris.theme.overrides', JSON.stringify(flood))
    assert.deepEqual(loadThemeOverrides(), {}, 'a hundred keys is not a palette, it is a payload')
  })
})

test('the store works with no window at all — the theme is state, the DOM only paints it', () => {
  // No `withStorage` here: in node the module has no window, and every write
  // must survive that rather than throw.
  assert.doesNotThrow(() => setThemeChoice('parchment'))
  assert.equal(getThemeChoice(), 'parchment')
  assert.doesNotThrow(() => setThemeOverrides({ '--iris-accent': '#112233' }))
})
