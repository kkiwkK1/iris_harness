/**
 * The expected-globals list, tied to the enumeration above it.
 *
 * `preset-globals.ts` opens with two independent statements of what a card
 * frame is supposed to already have: the five scripts upstream injects, and
 * MVU's own webpack externals — the consumer's statement of what it expects the
 * host to have put there. The exported array is supposed to be their union.
 *
 * For eleven runs it was not. `Vue` and `VueRouter` were named in both
 * statements and absent from the array, because the array had been read off the
 * table between them, and that table is organised by *where upstream gets each
 * library*. Vue is the one pair loaded by CDN tag rather than borrowed from the
 * parent window, so it fell out of a grouping that was never about need.
 *
 * What makes this worth a test rather than a correction is the failure mode. The
 * frame reports missing libraries **from this array**, so a name's absence from
 * it removes that name from every report the array can produce. The instrument
 * then cannot say the one true thing, and its silence is indistinguishable from
 * a pass: the banner named `showdown, toastr, EjsTemplate` — three libraries the
 * bundle in question never references — while the library that actually stopped
 * it went unmentioned. A reader was handed three wrong names and no right one.
 *
 * So the prose becomes the hub, exactly as `docs/SANDBOX.md` is for the allowlist.
 * Both statements are parsed out of the module's own documentation and required
 * to appear in the array. A future library added to the doc and forgotten in the
 * list fails here instead of eleven runs later.
 *
 * @module iris-web/tests/expected-globals-drift
 */
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import test from 'node:test'

import { EXPECTED_GLOBALS } from '../src/sandbox/preset-globals.ts'

/** The module's own source, so its documentation can be read as data. */
function moduleSource(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  return readFileSync(join(here, '..', 'src', 'sandbox', 'preset-globals.ts'), 'utf8')
}

/** Everything in backticks on the line stating MVU's externals. */
function documentedExternals(): string[] {
  const source = moduleSource()
  const marker = 'declares its externals as'
  const at = source.indexOf(marker)
  assert.notEqual(at, -1, 'the externals sentence is the anchor for this test and has been reworded')
  // To the end of the sentence, so a later paragraph mentioning a name in
  // backticks is not mistaken for part of the declaration.
  const stop = source.indexOf('.', source.indexOf('`z`', at))
  const names: string[] = []
  const span = source.slice(at, stop === -1 ? at + 400 : stop)
  const parts = span.split('`')
  // Odd indices are the quoted spans; a name is one token with no whitespace.
  for (let i = 1; i < parts.length; i += 2) {
    const name = (parts[i] ?? '').trim()
    if (name.length > 0 && !name.includes(' ')) names.push(name)
  }
  return names
}

/** Every library named in the injected-scripts list and the borrowing table. */
function documentedTableGlobals(): string[] {
  const source = moduleSource()
  const names: string[] = []
  for (const line of source.split('\n')) {
    const trimmed = line.replace('*', '').trim()
    if (!trimmed.startsWith('| `')) continue
    const parts = trimmed.split('`')
    for (let i = 1; i < parts.length; i += 2) {
      // `$` / `jQuery` occupies one cell as two names.
      const cell = (parts[i] ?? '').trim()
      if (cell.length > 0 && !cell.includes(' ')) names.push(cell)
    }
    // Only the first column names a global; the rest is prose.
    names.splice(names.length - countNamesAfterFirstCell(trimmed), countNamesAfterFirstCell(trimmed))
  }
  return names
}

/** How many backticked tokens on a table row belong to columns after the first. */
function countNamesAfterFirstCell(row: string): number {
  const cells = row.split('|')
  let extra = 0
  for (let i = 2; i < cells.length; i += 1) {
    const parts = (cells[i] ?? '').split('`')
    for (let j = 1; j < parts.length; j += 2) {
      const name = (parts[j] ?? '').trim()
      if (name.length > 0 && !name.includes(' ')) extra += 1
    }
  }
  return extra
}

test('every library MVU declares as an external is one the frame knows to look for', () => {
  const externals = documentedExternals()
  // The parse itself is checked: an empty result would pass every assertion
  // below while testing nothing, which is the failure this whole file is about.
  assert.ok(externals.length >= 8, `parsed too few externals: ${externals.join(', ')}`)
  assert.ok(externals.includes('Vue'), 'the externals sentence should still name Vue')

  for (const name of externals) {
    assert.ok(
      EXPECTED_GLOBALS.includes(name),
      `${name} is declared an external in this module's own documentation but is not in ` +
        'EXPECTED_GLOBALS, so the frame cannot report it missing and its silence means nothing',
    )
  }
})

test('every library in the borrowing table is one the frame knows to look for', () => {
  const documented = documentedTableGlobals()
  assert.ok(documented.length >= 7, `parsed too few table rows: ${documented.join(', ')}`)

  for (const name of documented) {
    assert.ok(
      EXPECTED_GLOBALS.includes(name),
      `${name} is documented as seeded by upstream but is not in EXPECTED_GLOBALS`,
    )
  }
})

test('the list carries no name the documentation does not justify', () => {
  const documented = new Set([...documentedExternals(), ...documentedTableGlobals()])
  for (const name of EXPECTED_GLOBALS) {
    assert.ok(
      documented.has(name),
      `${name} is reported as a missing library but nothing above says upstream provides it, ` +
        'so a card author would be told about an absence that is not upstream behaviour',
    )
  }
})
