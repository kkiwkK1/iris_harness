/**
 * The shell's card-file table against the host's.
 *
 * `packages/iris-app-service/src/library.ts` decides what `character.import`
 * stores (`EXTENSIONS`) and refuses `.charx` by name. The shell cannot import
 * that constant — it is not exported, and the package is Node-only — so the
 * shell keeps a table of its own (`src/app/card-files.ts`) and this file is what
 * makes the copy honest: it reads the host's source and holds every surface that
 * names a format to it.
 *
 * Why every surface, and not only the table: before this test the picker, both
 * copy strings and the fake each carried the list by hand, and all four still
 * offered `.charx` after the host had stopped taking it. Four copies that agree
 * by luck stay agreeing exactly until one of them is edited.
 *
 * @module iris-web/tests/card-files
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { test } from 'node:test'

import { CARD_FILE_ACCEPT, CARD_FILE_EXTENSIONS, CARD_FILE_LABELS } from '../src/app/card-files.ts'
import { DICTIONARIES } from '../src/app/i18n/strings.ts'
import { CARD_FILE_EXTENSIONS as FAKE_EXTENSIONS, readCard } from '../../../packages/iris-client-fake/src/card.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const HOST_LIBRARY = join(HERE, '..', '..', '..', 'packages', 'iris-app-service', 'src', 'library.ts')

/** Read one file relative to the app root. */
function source(...parts: string[]): string {
  return readFileSync(join(HERE, '..', ...parts), 'utf8')
}

/**
 * The host's list, parsed out of its source.
 *
 * Parsed rather than retyped: a retyped list would be a fifth copy, and the
 * point of this file is that there is one source. The shape asserted is the
 * declaration as written (`const EXTENSIONS = [...] as const`); if the host
 * restates it, this fails loudly here rather than silently matching nothing.
 */
function hostExtensions(): readonly string[] {
  const text = readFileSync(HOST_LIBRARY, 'utf8')
  const match = /const EXTENSIONS = \[([^\]]*)\] as const/.exec(text)
  assert.ok(match?.[1] !== undefined, `${HOST_LIBRARY} no longer declares EXTENSIONS as a const array`)
  const list = [...match[1].matchAll(/'([^']+)'/g)].map(m => m[1] ?? '')
  assert.ok(list.length > 0, 'the host list parsed as empty, which no card library could mean')
  // The premise this file rests on, checked rather than remembered: the host
  // still turns `.charx` away by name. If it ever starts reading them, the
  // shell's table is stale in the other direction and this is where it shows.
  assert.match(text, /extension === '\.charx'/, 'the host no longer refuses .charx by name; revisit card-files.ts')
  assert.ok(!list.includes('.charx'), 'the host stores .charx but also refuses it by name')
  return list
}

test('the shell table has exactly the host extensions, in the host order', () => {
  assert.deepEqual(Object.keys(CARD_FILE_EXTENSIONS), hostExtensions())
})

test('.jpeg is an alias of .jpg, and every label names its extension', () => {
  assert.equal(CARD_FILE_EXTENSIONS['.jpeg'], CARD_FILE_EXTENSIONS['.jpg'])
  for (const [extension, label] of Object.entries(CARD_FILE_EXTENSIONS)) {
    if (extension === '.jpeg') continue
    assert.equal(label, extension.slice(1).toUpperCase(), `${extension} is labelled ${label}`)
  }
  assert.deepEqual(CARD_FILE_LABELS, ['PNG', 'JPG', 'JSON'])
})

test('the picker accept attribute is the table, joined, and the picker uses it', () => {
  assert.equal(CARD_FILE_ACCEPT, Object.keys(CARD_FILE_EXTENSIONS).join(','))
  const sidebar = source('src', 'app', 'Sidebar.tsx')
  assert.match(sidebar, /accept=\{CARD_FILE_ACCEPT\}/, 'the card picker does not derive its accept list')
  assert.ok(!sidebar.includes('charx'), 'Sidebar.tsx still names .charx somewhere')
})

test('both copy strings name every label and no format the host refuses', () => {
  for (const [language, dictionary] of Object.entries(DICTIONARIES)) {
    const copy = dictionary.dropCard
    for (const label of CARD_FILE_LABELS) {
      assert.ok(copy.includes(label), `${language}.dropCard does not mention ${label}: ${copy}`)
    }
    assert.ok(!/charx/i.test(copy), `${language}.dropCard still offers .charx: ${copy}`)
  }
})

test('the fake client strips exactly the host extensions from a filename', () => {
  assert.deepEqual([...FAKE_EXTENSIONS], hostExtensions())
  for (const extension of hostExtensions()) {
    assert.equal(readCard(`Guest${extension.toUpperCase()}`, 'eA==').name, 'Guest', `${extension} not stripped`)
  }
  assert.equal(readCard('Guest.charx', 'eA==').name, 'Guest.charx')
})

test('the README names every host extension where it names any', () => {
  const readme = source('README.md')
  const named = hostExtensions().filter(extension => readme.includes(`\`${extension}\``))
  // A floor, not an early return: the README does describe `character.import`,
  // so "names none" would mean the paragraph was lost, not that there is
  // nothing to check.
  assert.ok(named.length > 0, 'README.md no longer names any card extension; its character.import note is gone')
  assert.deepEqual(named, hostExtensions(), 'README.md names some card extensions but not all of them')
})
