/**
 * The host half of `/doctor`: every fact is a fresh reading, and none is a
 * secret.
 *
 * @module @iris/app-service/tests/doctor
 */

import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

import { entryScriptName, readHostDoctorFacts } from '../src/doctor.ts'
import { IRIS_VERSION } from '../src/version.ts'
import { tempDir } from './support/temp-dir.ts'

/** A scratch data directory, removed after the test by the shared helper. */
async function scratch(t: TestContext): Promise<string> {
  return tempDir(t, 'iris-doctor-')
}

/** A lock record in the shape `acquireHostLock` writes. */
function lockText(pid: number): string {
  return JSON.stringify({ pid, port: 8791, hostname: 'probe', startedAt: '2026-09-23T00:00:00.000Z' })
}

test('the entry is the module script, not the inline ones before it', () => {
  const html = [
    '<!doctype html><html><head>',
    '<script>/* pre-paint */</script>',
    '<script type="module" crossorigin src="./assets/index-hUStB4Sx.js"></script>',
    '</head><body></body></html>',
  ].join('\n')
  assert.equal(entryScriptName(html), 'index-hUStB4Sx.js')
  // The dev server's entry is a source path, and it is still named: the page
  // decides what a non-hashed name means, not this reader.
  assert.equal(entryScriptName('<script type="module" src="/src/main.tsx"></script>'), 'main.tsx')
  assert.equal(entryScriptName('<script src="./classic.js"></script>'), undefined)
})

test('the lock pid is read from the file now, so a second host taking it over shows', async (t) => {
  const dataDir = await scratch(t)
  await writeFile(join(dataDir, 'host.lock'), lockText(4242))
  const own = await readHostDoctorFacts({ dataDir, pid: 4242, node: 'v24.0.0' })
  assert.equal(own.dataDir.lockPid, 4242)
  assert.equal(own.pid, 4242)
  assert.equal(own.dataDir.writable, true)
  assert.equal(own.irisVersion, IRIS_VERSION)
  assert.equal(own.node, 'v24.0.0')

  await writeFile(join(dataDir, 'host.lock'), lockText(9999))
  const taken = await readHostDoctorFacts({ dataDir, pid: 4242 })
  assert.equal(taken.dataDir.lockPid, 9999, 'the reading was captured once instead of taken per call')
})

test('a missing lock is an absent pid, not a zero', async (t) => {
  const dataDir = await scratch(t)
  const facts = await readHostDoctorFacts({ dataDir })
  assert.equal('lockPid' in facts.dataDir, false)
})

test('the served bundle is read from the index per call, so a rebuild under a running host shows', async (t) => {
  const dataDir = await scratch(t)
  const index = join(dataDir, 'index.html')
  await writeFile(index, '<script type="module" src="./assets/index-OLD.js"></script>')
  const before = await readHostDoctorFacts({ dataDir, webDistIndex: index })
  assert.deepEqual(before.webBundle, { entry: 'index-OLD.js' })
  await writeFile(index, '<script type="module" src="./assets/index-NEW.js"></script>')
  const after = await readHostDoctorFacts({ dataDir, webDistIndex: index })
  assert.deepEqual(after.webBundle, { entry: 'index-NEW.js' })
})

test('no build configured is an absent field; a configured build that cannot be read is an empty one', async (t) => {
  const dataDir = await scratch(t)
  const none = await readHostDoctorFacts({ dataDir })
  assert.equal('webBundle' in none, false)
  const missing = await readHostDoctorFacts({ dataDir, webDistIndex: join(dataDir, 'nope', 'index.html') })
  assert.deepEqual(missing.webBundle, {})
})

test('the corpus directory is absent when unset and unreadable when it does not exist', async (t) => {
  const dataDir = await scratch(t)
  assert.equal('corpusDir' in await readHostDoctorFacts({ dataDir }), false)
  const readable = await readHostDoctorFacts({ dataDir, sillyTavernDir: dataDir })
  assert.deepEqual(readable.corpusDir, { path: dataDir, readable: true })
  const gone = join(dataDir, 'no-such-profile')
  const unreadable = await readHostDoctorFacts({ dataDir, sillyTavernDir: gone })
  assert.deepEqual(unreadable.corpusDir, { path: gone, readable: false })
})

test('card storage reports its size against the cap it is given', async (t) => {
  const dataDir = await scratch(t)
  const facts = await readHostDoctorFacts({
    dataDir,
    cardStorage: { size: () => Promise.resolve(512), limit: 1024 },
  })
  assert.deepEqual(facts.cardStorage, { bytes: 512, limit: 1024 })
})

test('the doctor module never opens the connection store or names a key', async () => {
  // A source pin, because the property is about what the module *could*
  // read: a test of today's output would pass for a module that reads the key
  // file and happens not to return it.
  const source = await readFile(new URL('../src/doctor.ts', import.meta.url), 'utf8')
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
  for (const banned of ['connections.json', 'apiKey', 'keyTail', 'connections.ts', 'ConnectionStore']) {
    assert.equal(code.includes(banned), false, `doctor.ts mentions ${banned} outside a comment`)
  }
})
