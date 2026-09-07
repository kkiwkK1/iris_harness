/**
 * The sidebar tabs carry a handle that does not change with the language.
 *
 * The two tab buttons are identical but for their translated label — same role,
 * same class — so every acceptance script that located one by its text broke
 * the day the shell learned to speak the reader's language: a probe asking for
 * `Characters` gets `no Characters tab: 阅读|角色库`. `data-tab` is the handle
 * that survives translation, and it is the state's own value so the store, the
 * DOM and the scripts share one vocabulary.
 *
 * Pinned against the source, the way `shell-page.test.ts` pins the page head:
 * there is no DOM harness for a `.tsx` in this suite, and a fact about markup
 * is a fact about the file that writes it.
 *
 * @module iris-web/tests/sidebar-tabs
 */

import { join, dirname } from 'node:path'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import test from 'node:test'
import assert from 'node:assert/strict'

const source = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'app', 'Sidebar.tsx'),
  'utf8',
)

/** Just the tablist, so a `data-tab` elsewhere in the file cannot satisfy this. */
const tablist = (): string => {
  const opens = source.indexOf('<div className="iris-tabs" role="tablist">')
  const closes = source.indexOf('<div className="iris-list"', opens)
  assert.ok(opens >= 0, 'the tablist container was renamed or removed')
  assert.ok(closes > opens, 'the list panel no longer follows the tablist')
  return source.slice(opens, closes)
}

test('each tab carries a data-tab handle, so an instrument never reads a label', () => {
  const values = [...tablist().matchAll(/data-tab="([^"]+)"/gu)].map(m => m[1])
  assert.deepEqual(
    values,
    ['chats', 'characters'],
    'a tab lost its language-independent handle, so locating it needs its translated text again',
  )
  assert.equal(new Set(values).size, values.length, 'two tabs share one handle, so it identifies neither')
})

test('a tab handle is the value its click writes, or the DOM and the store disagree', () => {
  /*
   * The drift this catches: `data-tab` and `setTab('…')` are two literals for
   * one identity, ten lines apart. Renaming the state value and leaving the
   * attribute behind leaves every instrument pointing at a tab the store has
   * never heard of — and nothing else in the suite would notice, because the
   * attribute is still there and still unique.
   *
   * Read in document order and zipped: within the tablist each button writes
   * its `data-tab` before its `onClick`, so the nth of each belong together.
   */
  const block = tablist()
  const handles = [...block.matchAll(/data-tab="([^"]+)"/gu)].map(m => m[1])
  const writes = [...block.matchAll(/setTab\('([^']+)'\)/gu)].map(m => m[1])
  assert.equal(
    handles.length,
    writes.length,
    `${String(handles.length)} handle(s) but ${String(writes.length)} setTab call(s): the pairing below cannot be trusted`,
  )
  assert.ok(handles.length >= 2, `only ${String(handles.length)} tab(s) compared — the slice stopped seeing them`)
  assert.deepEqual(handles, writes, 'a tab advertises one identity and writes another')
})
