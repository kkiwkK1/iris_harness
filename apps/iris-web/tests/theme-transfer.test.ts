/**
 * The theme package: build, serialise, parse — and the same theme comes back.
 *
 * The export exists so a tuned look can move between machines, so the whole
 * promise is the round trip: `buildThemePackage` → `JSON.stringify` →
 * `parseThemePackage` must land on the same palette, the same stylesheet, the
 * same switch. The import's diff rule is pinned too: a stock palette applies
 * as **no** overrides (so it cannot shadow later theme switches), and a
 * customised palette survives as exactly the keys that differ.
 *
 * @module iris-web/tests/theme-transfer
 */
import { strict as assert } from 'node:assert'
import test from 'node:test'

import { THEME_PRESETS } from '../src/theme/presets.ts'
import {
  buildThemePackage,
  overridesFromPackage,
  packageThemeId,
  parseThemePackage,
} from '../src/theme/theme-transfer.ts'

test('build, serialise, parse: the round trip is the same theme', () => {
  const file = buildThemePackage({
    themeId: 'parchment',
    overrides: { '--iris-accent': '#010203' },
    userCss: { css: '.iris-drawer { letter-spacing: 0.02em; }', enabled: true },
  })
  const parsed = parseThemePackage(JSON.stringify(file))
  assert.ok(parsed.ok)

  assert.equal(parsed.data.format, 'iris.theme')
  assert.equal(parsed.data.theme.id, 'parchment')
  assert.equal(parsed.data.theme.tokens['--iris-accent'], '#010203')
  assert.deepEqual(parsed.data.userCss, { css: '.iris-drawer { letter-spacing: 0.02em; }', enabled: true })

  // Every other parchment value is the built-in: the overrides were folded
  // into a full palette, not lost and not spread.
  const parchment = THEME_PRESETS.find(preset => preset.id === 'parchment')
  assert.ok(parchment !== undefined)
  for (const [token, value] of Object.entries(parchment.tokens)) {
    if (token === '--iris-accent') continue
    assert.equal(parsed.data.theme.tokens[token], value)
  }
})

test('a stock package applies as no overrides at all', () => {
  const file = buildThemePackage({
    themeId: 'light',
    userCss: { css: '', enabled: false },
  })
  assert.deepEqual(overridesFromPackage(file), {},
    'importing a theme nobody customised must not shadow later theme switches')
})

test('a customised package survives as exactly the keys that differ', () => {
  const file = buildThemePackage({
    themeId: 'dark',
    overrides: { '--iris-accent': '#ff80aa', '--iris-scrollbar': '#443366' },
    userCss: { css: '', enabled: false },
  })
  assert.deepEqual(overridesFromPackage(file), {
    '--iris-accent': '#ff80aa',
    '--iris-scrollbar': '#443366',
  })
})

test('a file that does not name the format is refused whole', () => {
  assert.deepEqual(parseThemePackage('not json at all'), { ok: false, reason: 'bad-json' })
  assert.deepEqual(parseThemePackage('[]'), { ok: false, reason: 'bad-format' })
  assert.deepEqual(
    parseThemePackage('{"format": "iris.settings", "version": 1}'),
    { ok: false, reason: 'bad-format' },
    'the settings file is a different format, however friendly',
  )
  assert.deepEqual(
    parseThemePackage('{"format": "iris.theme", "version": 1, "theme": {"id": "dark", "tokens": {}}}'),
    { ok: false, reason: 'bad-format' },
    'a package with no user.css section is half a package',
  )
  assert.deepEqual(
    parseThemePackage('{"format": "iris.theme", "version": 1, "userCss": {"css": "", "enabled": false}}'),
    { ok: false, reason: 'bad-format' },
    'a package with no theme section is half a package',
  )
})

test('an unknown theme id is reported as unknown, not coerced', () => {
  assert.equal(packageThemeId('parchment'), 'parchment')
  assert.equal(packageThemeId('dark'), 'dark')
  assert.equal(packageThemeId('plaid'), undefined)
  assert.equal(packageThemeId(42), undefined)
})

test('unknown extra keys ride along harmlessly', () => {
  const parsed = parseThemePackage(
    JSON.stringify({
      format: 'iris.theme',
      version: 1,
      futureKey: { deep: true },
      theme: { id: 'light', tokens: {}, note: 'from a newer build' },
      userCss: { css: '/* hi */', enabled: false },
    }),
  )
  assert.ok(parsed.ok)
  assert.deepEqual(overridesFromPackage(parsed.data), {})
  assert.equal(parsed.data.userCss.css, '/* hi */')
})
