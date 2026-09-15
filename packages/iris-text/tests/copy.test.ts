import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  auditBilingualCopy,
  auditCopyTable,
  copySlots,
  PLUGIN_COPY_KEY_RE,
  PLUGIN_COPY_LANGUAGES,
  PLUGIN_COPY_LIMITS,
} from '../src/index.ts'

/**
 * The three rules the host's install gate applies to a plugin's bundled copy
 * (`auditPluginCopy`, `packages/iris-app-service/src/plugins/manifest.ts`) are
 * the three rules `apps/iris-web/tests/i18n.test.ts` applies to the shell's
 * own dictionaries. One implementation is the point of this module — which is
 * also why the negatives below matter as much as the positives: a rule whose
 * refusal is never exercised is a rule a refactor can silently detach, and
 * both consumers would stay green while computing their own thing again.
 */

test('the shipped ceilings are the ones the rulings named', () => {
  // A moved number shortens an answer instead of erroring, so the values are
  // pinned, not derived — the same shape `PLUGIN_TREE_LIMITS` is pinned by.
  assert.equal(PLUGIN_COPY_LIMITS.maxBytes, 256 * 1024)
  assert.equal(PLUGIN_COPY_LIMITS.maxKeys, 2_000)
  assert.deepEqual([...PLUGIN_COPY_LANGUAGES], ['en', 'zh'])
  // The two ceilings are per file, not per plugin: one column of copy may be
  // the size of the shell's whole dictionary, and no smaller.
  assert.ok(PLUGIN_COPY_LIMITS.maxBytes > 100 * 1024, 'one column must hold what the shell’s own en column holds')
})

test('copySlots compares slot sets: deduplicated and sorted', () => {
  assert.deepEqual(copySlots('{b} and {a} and {b} again'), ['a', 'b'])
  assert.deepEqual(copySlots('no slots at all'), [])
  // A slot is `\w+` and nothing else — the same grammar `interpolate` fills.
  assert.deepEqual(copySlots('{name} vs {name_2}'), ['name', 'name_2'])
})

test('auditCopyTable refuses keys outside the grammar', () => {
  // `__proto__` is refused by the same grammar that refuses `1abc`: the key
  // becomes part of `plugin:<id>:<key>`, and an inheritable name in a merged
  // plain object is exactly what the grammar exists to keep out.
  for (const bad of ['1abc', 'a-b', 'a.b', '', '__proto__', '你好', 'send it']) {
    const failure = auditCopyTable({ [bad]: 'value' }, 'i18n.en')
    assert.ok(failure !== null, `expected "${bad}" to be refused`)
    assert.equal(failure.field, `i18n.en.${bad}`)
    assert.match(failure.reason, /does not match/)
  }
  assert.equal(PLUGIN_COPY_KEY_RE.test('aB1'), true)
})

test('auditCopyTable refuses non-string values and oversized tables', () => {
  const notString = auditCopyTable({ count: 12 }, 'i18n.en')
  assert.ok(notString !== null)
  assert.equal(notString.field, 'i18n.en.count')
  assert.match(notString.reason, /expected a string value, got number/)

  const oversized: Record<string, string> = {}
  for (let index = 0; index <= PLUGIN_COPY_LIMITS.maxKeys; index++) {
    oversized[`k${String(index)}`] = 'value'
  }
  const tooMany = auditCopyTable(oversized, 'i18n.zh')
  assert.ok(tooMany !== null)
  // A ceiling failure names the column, not a key: the problem is the table's.
  assert.equal(tooMany.field, 'i18n.zh')
  assert.match(tooMany.reason, /over the 2000-string limit/)

  // Exactly at the ceiling is still clean.
  delete oversized[`k${String(PLUGIN_COPY_LIMITS.maxKeys)}`]
  assert.equal(auditCopyTable(oversized, 'i18n.zh'), null)
})

test('auditBilingualCopy refuses a key the two columns do not share, and names it', () => {
  const missing = auditBilingualCopy({ greeting: 'hello' }, {}, { field: 'i18n' })
  assert.ok(missing !== null)
  assert.equal(missing.field, 'i18n.zh')
  assert.match(missing.reason, /missing from zh.*greeting/s)

  const extra = auditBilingualCopy({}, { farewell: '再见' }, { field: 'i18n' })
  assert.ok(extra !== null)
  assert.equal(extra.field, 'i18n.zh')
  assert.match(extra.reason, /only in zh.*farewell/s)
})

test('auditBilingualCopy refuses an all-English zh value, unless the key is neutral', () => {
  const failure = auditBilingualCopy({ greeting: 'hello' }, { greeting: 'hello' }, { field: 'i18n' })
  assert.ok(failure !== null)
  assert.equal(failure.field, 'i18n.zh.greeting')
  assert.match(failure.reason, /zh\["greeting"\] has no Chinese: hello/)

  const neutral = new Set(['topP'])
  assert.equal(
    auditBilingualCopy({ topP: '1.0' }, { topP: '1.0' }, { neutralKeys: neutral, field: 'i18n' }),
    null,
    'a whitelisted row is the caller’s fact, not the rule’s',
  )
})

test('auditBilingualCopy refuses placeholder drift, naming the key', () => {
  const failure = auditBilingualCopy(
    { greeting: 'hello {name}' },
    { greeting: '你好' },
    { field: 'i18n' },
  )
  assert.ok(failure !== null)
  assert.equal(failure.field, 'i18n.zh.greeting')
  assert.match(failure.reason, /placeholder drift on "greeting"/)

  // A repeated slot in one column only is grammar, not drift.
  assert.equal(
    auditBilingualCopy({ of: '{a} of {b}' }, { of: '{b} 个中的 {a} 个' }, { field: 'i18n' }),
    null,
  )
})

test('auditBilingualCopy passes a clean bilingual pair', () => {
  assert.equal(
    auditBilingualCopy(
      { greeting: 'hello {name}', send: 'Send' },
      { greeting: '你好，{name}', send: '发送' },
      { field: 'i18n' },
    ),
    null,
  )
})
