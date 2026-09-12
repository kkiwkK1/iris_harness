import assert from 'node:assert/strict'
import { test } from 'node:test'

import { normalizeManifest } from '../src/manifest.ts'

test('normalizes every field ST 1.18.0 reads, and lists what it does not', () => {
  const outcome = normalizeManifest({
    display_name: 'Prompt Template/提示词模板',
    loading_order: '10',
    requires: [],
    optional: ['extras'],
    dependencies: ['regex'],
    js: 'dist/index.js',
    css: '',
    i18n: { 'zh-cn': 'locales/zh-cn.json' },
    author: 'zonde306',
    version: '1.17.4.1',
    homePage: 'https://github.com/zonde306/ST-Prompt-Template',
    auto_update: true,
    future_field: { nested: true },
  })
  assert.ok(outcome.ok)
  const { manifest } = outcome
  assert.equal(manifest.displayName, 'Prompt Template/提示词模板')
  assert.equal(manifest.loadingOrder, 10, 'loading_order arrives as a numeric string; ST parseInt\'s it and so do we')
  assert.equal(manifest.js, 'dist/index.js')
  assert.equal(manifest.css, undefined, 'empty css is absent css — the host skips loading, we skip claiming')
  assert.deepEqual(manifest.requires, [])
  assert.deepEqual(manifest.optional, ['extras'])
  assert.deepEqual(manifest.dependencies, ['regex'])
  assert.deepEqual(manifest.i18n, { 'zh-cn': 'locales/zh-cn.json' })
  assert.deepEqual(manifest.unknownFields, ['future_field'])
})

test('refuses entry paths that are not relative in-tree paths', () => {
  for (const js of ['/abs/index.js', '../escape.js', 'a\\b.js', 'https://cdn.example/x.js']) {
    const outcome = normalizeManifest({ display_name: 'x', js })
    assert.ok(!outcome.ok, js)
    assert.ok(outcome.issues.some(issue => issue.field === 'js'), js)
  }
  // the one non-path ST itself tolerates: an empty js is a css-only
  // extension (extensions.js:429 `if (!manifest.js)`), so it normalizes to
  // absence rather than a refusal
  const empty = normalizeManifest({ display_name: 'x', js: '' })
  assert.ok(empty.ok)
  assert.equal(empty.manifest.js, undefined)
})

test('refuses wrong-shaped known fields and names the field', () => {
  const outcome = normalizeManifest({
    display_name: 'x',
    requires: 'extras',
    dependencies: [1],
    i18n: { 'zh-cn': '../escape.json' },
  })
  assert.ok(!outcome.ok)
  const fields = outcome.issues.map(issue => issue.field)
  assert.ok(fields.includes('requires'))
  assert.ok(fields.includes('dependencies'))
  assert.ok(fields.includes('i18n.zh-cn'))
})

test('tolerates what the host tolerates, without inventing a value', () => {
  const outcome = normalizeManifest({ display_name: 'x', js: 'index.js', loading_order: 'first' })
  assert.ok(outcome.ok)
  assert.equal(outcome.manifest.loadingOrder, undefined, 'ST sorts on parseInt NaN; we drop it, we do not guess')
})

test('a non-object manifest is one refusal, not a crash', () => {
  for (const raw of [null, [], 'text', 3]) {
    const outcome = normalizeManifest(raw)
    assert.ok(!outcome.ok)
    assert.equal(outcome.issues.length, 1)
  }
})
