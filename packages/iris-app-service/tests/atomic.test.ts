import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { test, type TestContext } from 'node:test'

import {
  atomicWriteFile, quarantineCorruptFile, quarantineUnparsable, readJsonStore,
} from '../src/atomic.ts'

/**
 * The replace-or-leave-alone helper every store in this package writes through.
 *
 * **What these tests are for.** The claim `atomic.ts` makes is a claim about a
 * moment nobody can observe directly: the instant between "the old file is
 * gone" and "the new file is whole". A test cannot pull the power out, so it
 * does the next thing — it asserts the two observable consequences of the
 * mechanism that closes that window. First, that the temporary is *gone* on
 * every path, which is what says the rename happened rather than a write into
 * the target; a leaked temporary is also a file the directory scans in
 * `backups.ts` and `cache-trace.ts` would have to step over. Second, that a
 * failed write leaves the previous bytes untouched, which is the whole promise.
 *
 * And one that is a claim about *this machine* rather than about the code:
 * `rename` over an existing path. POSIX replaces; Windows replaces only because
 * Node asks for `MOVEFILE_REPLACE_EXISTING`, and the whole design rests on it,
 * so it is measured on whatever host runs the suite rather than cited.
 */

/** A fresh directory, removed when the test ends. */
async function scratch(t: TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'iris-atomic-'))
  t.after(async () => { await rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }) })
  return dir
}

/** Everything in the directory that looks like one of this helper's temporaries. */
async function temporaries(dir: string): Promise<string[]> {
  return (await readdir(dir)).filter(name => name.endsWith('.tmp'))
}

test('no module in this package writes a file except through this one', async () => {
  // **A source pin, and the only net that covers all twenty-eight write sites.**
  // Each site's atomicity is a property of a moment a test cannot stand inside,
  // so proving it per site would mean twenty-eight instrumented writes. The
  // property that *is* checkable, and the one that actually regresses, is the
  // import: `writeFile` reaches this package through exactly one module, so a
  // store added later cannot quietly write its file the old way, and neither
  // can an edit to an existing one.
  //
  // Deliberately about the import rather than the call, because the import is
  // what a new site needs and what a reviewer sees at the top of the diff. A
  // caller reaching for `node:fs`'s sync form would slip through this and is
  // covered by the second assertion.
  const src = new URL('../src/', import.meta.url)
  const modules = (await readdir(src)).filter(name => name.endsWith('.ts') && name !== 'atomic.ts')
  assert.ok(modules.length > 40, 'the source scan found almost nothing — is the path right?')

  const offenders: string[] = []
  for (const name of modules) {
    const text = await readFile(new URL(name, src), 'utf8')
    for (const line of text.split('\n')) {
      if (/^import .*\bwriteFile\b.*from 'node:fs/u.test(line)) offenders.push(`${name}: ${line.trim()}`)
      if (/\bwriteFileSync\s*\(/u.test(line)) offenders.push(`${name}: ${line.trim()}`)
    }
  }
  assert.deepEqual(offenders, [],
    'a module writes files outside atomic.ts — every write in this package goes through atomicWriteFile')
})

test('a successful write lands the exact bytes and leaves no temporary', async (t) => {
  const dir = await scratch(t)
  const path = join(dir, 'settings.json')

  await atomicWriteFile(path, '{\n  "a": 1\n}\n')
  assert.equal(await readFile(path, 'utf8'), '{\n  "a": 1\n}\n')
  assert.deepEqual(await temporaries(dir), [], 'a temporary survived a successful write')
  assert.deepEqual(await readdir(dir), ['settings.json'], 'the write left something beside its target')
})

test('a string is written as UTF-8 and bytes are written as they are', async (t) => {
  const dir = await scratch(t)

  // The two overloads have to agree with what the call sites used to pass:
  // every text store wrote `'utf8'` explicitly, and `library.ts` wrote a card's
  // PNG with no encoding at all. A single code path that stringified the buffer
  // would pass a test that only ever wrote ASCII.
  const text = join(dir, 'text.json')
  await atomicWriteFile(text, '{"名前":"爱衣"}')
  assert.deepEqual(await readFile(text), Buffer.from('{"名前":"爱衣"}', 'utf8'))

  const bytes = join(dir, 'card.png')
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0xfe])
  await atomicWriteFile(bytes, png)
  assert.deepEqual(await readFile(bytes), png)
})

test('a mode asked for is on the file the rename leaves behind', async (t) => {
  const dir = await scratch(t)
  const path = join(dir, 'connections.key')
  await atomicWriteFile(path, '{"kind":"file"}\n', { mode: 0o600 })
  assert.equal(await readFile(path, 'utf8'), '{"kind":"file"}\n')
  assert.deepEqual(await temporaries(dir), [], 'a temporary survived a write with a mode')

  // Whether those bits *mean* anything is the platform's answer rather than
  // this code's: Windows does not enforce them, so asserting them there would
  // pin the operating system instead of the argument. The one caller that asks
  // — `key-protection.ts`, for the wrapped data key — carries a source pin of
  // its own for exactly this reason; see `key-at-rest.test.ts`.
  if (process.platform !== 'win32') {
    assert.equal((await stat(path)).mode & 0o777, 0o600, 'the mode did not reach the file')
    const plain = join(dir, 'settings.json')
    await atomicWriteFile(plain, '{}\n')
    assert.notEqual((await stat(plain)).mode & 0o777, 0o600,
      'every write is 0600 now, which is not what the option asked for')
  }
})

test('rename over an existing file replaces it, on this operating system', async (t) => {
  const dir = await scratch(t)
  const path = join(dir, 'chat.jsonl')

  // The load-bearing platform fact. On Windows a plain `MoveFile` onto an
  // existing name fails with EEXIST/EPERM; Node's `rename` asks for
  // `MOVEFILE_REPLACE_EXISTING`, so it does not. Measured rather than cited,
  // because the whole package now depends on it.
  await writeFile(path, 'first\n', 'utf8')
  await atomicWriteFile(path, 'second\n')
  assert.equal(await readFile(path, 'utf8'), 'second\n')
  assert.deepEqual(await temporaries(dir), [])
})

test('the target keeps its old bytes until the whole new file exists', async (t) => {
  const dir = await scratch(t)
  const path = join(dir, 'chat.jsonl')
  await writeFile(path, 'ORIGINAL\n', 'utf8')

  // **The test that pins the mechanism rather than its tidiness.** Every other
  // assertion in this file is also true of a plain `writeFile` — the bytes
  // land, no temporary is left, a failure propagates — so a helper that had
  // quietly lost its temp-and-rename would keep the suite green. This one looks
  // *inside* the write: `writeFile` accepts an async iterable, so the second
  // chunk is produced only after the directory has been inspected, and at that
  // moment a non-atomic writer has already truncated the target.
  let duringTarget = ''
  let duringDir: string[] = []
  const body = (async function* body(): AsyncGenerator<string> {
    yield 'REPLACEMENT '
    duringTarget = await readFile(path, 'utf8')
    duringDir = await readdir(dir)
    yield 'FINISHED\n'
  })()

  await atomicWriteFile(path, body as unknown as Uint8Array)

  assert.equal(duringTarget, 'ORIGINAL\n',
    'the target was already being overwritten while the new contents were still arriving')
  assert.ok(duringDir.some(name => name.endsWith('.tmp')),
    'nothing was being written to a temporary')
  assert.equal(await readFile(path, 'utf8'), 'REPLACEMENT FINISHED\n')
  assert.deepEqual(await temporaries(dir), [])
})

test('a write that fails partway leaves the previous file whole', async (t) => {
  const dir = await scratch(t)
  const path = join(dir, 'connections.json')
  await writeFile(path, '{"profiles":[{"id":"a"}]}\n', 'utf8')

  // The same instrument, used for the failure this module exists to close: some
  // bytes are written and then the source of them throws, which is what a full
  // disk, a killed process and a power cut all look like from here. A plain
  // `writeFile` would leave the truncated prefix in the file; there is nothing
  // to leave here, because none of it was ever in the target.
  const body = (async function* body(): AsyncGenerator<string> {
    yield '{"profiles":['
    throw new Error('injected mid-write failure')
  })()

  await assert.rejects(() => atomicWriteFile(path, body as unknown as Uint8Array),
    /injected mid-write failure/u, 'the injected failure did not reach the caller')
  assert.equal(await readFile(path, 'utf8'), '{"profiles":[{"id":"a"}]}\n',
    'a write that failed partway destroyed the file it was replacing')
  assert.deepEqual(await temporaries(dir), [], 'a failed write left its temporary behind')
})

test('a failure while writing the temporary reaches the caller and leaves nothing behind', async (t) => {
  const dir = await scratch(t)

  // The write stage fails for real rather than through a stub: the directory the
  // temporary would go into is not there, which is the shape a full disk, a
  // revoked permission and a deleted profile all take at this line. What the
  // test is actually about is the `catch`: the failure must reach the caller,
  // and nothing of the attempt may survive it.
  await assert.rejects(
    () => atomicWriteFile(join(dir, 'gone', 'settings.json'), '{}\n'),
    (error: NodeJS.ErrnoException) => error.code === 'ENOENT',
    'a failed write did not reach the caller',
  )
  assert.deepEqual(await readdir(dir), [], 'a failed write left something behind')
})

test('a failure at the rename leaves the original bytes and no temporary', async (t) => {
  const dir = await scratch(t)
  const path = join(dir, 'connections.json')
  await writeFile(path, '{"profiles":[{"id":"a"}]}\n', 'utf8')

  // The other half of the window, and the half that matters: the temporary is
  // written and the replace is what fails. `rename` onto a non-empty directory
  // is refused by every filesystem this runs on, so the failure is real and the
  // target it refuses to replace is a path whose contents can be read back
  // afterwards — which is the assertion. A helper that wrote into the target
  // first and only then discovered the problem would fail this.
  const blocked = join(dir, 'blocked')
  await mkdir(join(blocked, 'inside'), { recursive: true })
  await writeFile(join(blocked, 'inside', 'kept.txt'), 'still here', 'utf8')

  await assert.rejects(() => atomicWriteFile(blocked, 'replacement'),
    'a rename over a non-empty directory was reported as a success')
  assert.equal(await readFile(join(blocked, 'inside', 'kept.txt'), 'utf8'), 'still here',
    'the target was damaged by a write that failed')
  assert.equal(await readFile(path, 'utf8'), '{"profiles":[{"id":"a"}]}\n')
  assert.deepEqual(await temporaries(dir), [], 'a failed rename left its temporary behind')
})

test('two writers to one path end with one intact file', async (t) => {
  const dir = await scratch(t)
  const path = join(dir, 'chat.jsonl')

  // Each writer's temporary carries its own random suffix, so they cannot
  // collide; the rename decides which one wins. What must never happen is a
  // blend of the two, which is exactly what two concurrent `writeFile` calls to
  // one path can produce.
  //
  // **This test found something.** On Windows the losing rename came back
  // `EPERM` — the target is briefly un-replaceable while the winner's delete is
  // pending — so an overlapping pair of saves would have *thrown* where the old
  // non-atomic write merely corrupted. `renameWithRetry` is the answer. The
  // race is not reliable enough to be the retry's test (it reproduced on one
  // run and not the next), so the deterministic one lives above and this stays
  // what its name says: whichever writer wins, the file is one of the two.
  const first = `${'a'.repeat(200_000)}\n`
  const second = `${'b'.repeat(200_000)}\n`
  await Promise.all([atomicWriteFile(path, first), atomicWriteFile(path, second)])

  const landed = await readFile(path, 'utf8')
  assert.ok(landed === first || landed === second,
    'two concurrent writers produced a file that is neither of them')
  assert.deepEqual(await temporaries(dir), [], 'a concurrent write left a temporary behind')
})

/**
 * A stand-in `rename` that refuses with `code` the first `refusals` times and
 * then performs the real rename, recording every attempt and every wait.
 *
 * **Why a stand-in and not a held handle.** The retry exists for a Windows
 * behaviour: while any handle is open on the target, `rename` onto it comes
 * back `EPERM` (measured; a reader such as `chat.search`, a backup being taken,
 * an antivirus opening the new file is enough). A first version of this test
 * provoked that by holding the target open — and was green on Windows and red
 * on the Linux CI runner, where POSIX `rename` over an open file succeeds at
 * once and "the write finished before the handle was released" was false. A
 * test whose teeth depend on the host it runs on is not a test of the code, so
 * the platform call is injected and the sequence asserted on every platform.
 */
function refusing(code: string, refusals: number): {
  rename: (from: string, to: string) => Promise<void>
  wait: (ms: number) => Promise<void>
  attempts: number
  waits: number[]
} {
  const log = {
    attempts: 0,
    waits: [] as number[],
    async rename(from: string, to: string): Promise<void> {
      log.attempts += 1
      if (log.attempts <= refusals) throw Object.assign(new Error(`${code}: stand-in refusal`), { code })
      await rename(from, to)
    },
    async wait(ms: number): Promise<void> { log.waits.push(ms) },
  }
  return log
}

test('a replace the platform refuses for a moment is waited out, not failed', async (t) => {
  const dir = await scratch(t)
  const path = join(dir, 'chat.jsonl')
  await writeFile(path, 'ORIGINAL\n', 'utf8')

  const platform = refusing('EPERM', 3)
  await atomicWriteFile(path, 'REPLACED\n', platform)

  assert.equal(platform.attempts, 4, 'three refusals and the success are four attempts')
  assert.deepEqual(platform.waits, [1, 2, 4], 'the backoff doubles from one millisecond')
  assert.equal(await readFile(path, 'utf8'), 'REPLACED\n')
  assert.deepEqual(await temporaries(dir), [], 'a retried rename left its temporary behind')
})

test('a refusal that is not a busy target is not retried, and the previous bytes stand', async (t) => {
  const dir = await scratch(t)
  const path = join(dir, 'chat.jsonl')
  await writeFile(path, 'ORIGINAL\n', 'utf8')

  const platform = refusing('ENOENT', 99)
  await assert.rejects(atomicWriteFile(path, 'REPLACED\n', platform), { code: 'ENOENT' })

  assert.equal(platform.attempts, 1, 'a code outside the retryable set was retried')
  assert.deepEqual(platform.waits, [], 'a non-retryable refusal was waited on')
  assert.equal(await readFile(path, 'utf8'), 'ORIGINAL\n', 'the failed replace touched the target')
  assert.deepEqual(await temporaries(dir), [], 'a failed rename left its temporary behind')
})

test('a target still refused after ten attempts fails as the caller’s problem, cleanly', async (t) => {
  const dir = await scratch(t)
  const path = join(dir, 'chat.jsonl')
  await writeFile(path, 'ORIGINAL\n', 'utf8')

  const platform = refusing('EBUSY', 99)
  await assert.rejects(atomicWriteFile(path, 'REPLACED\n', platform), { code: 'EBUSY' })

  assert.equal(platform.attempts, 10, 'the retry did not stop at ten attempts')
  assert.deepEqual(platform.waits, [1, 2, 4, 8, 16, 32, 64, 128, 256], 'nine waits between ten attempts')
  assert.equal(await readFile(path, 'utf8'), 'ORIGINAL\n', 'a still-refused replace touched the target')
  assert.deepEqual(await temporaries(dir), [], 'an exhausted retry left its temporary behind')
})

test('a file that will not parse is set aside under a name no store writes', async (t) => {
  const dir = await scratch(t)
  const path = join(dir, 'settings.json')
  await writeFile(path, '{ "global": { "temp', 'utf8')

  const said: string[] = []
  const at = new Date('2026-09-11T12:34:56.789Z')
  const parsed = await readJsonStore(path, message => { said.push(message) }, at)

  assert.equal(parsed, undefined, 'an unparsable file was handed back as a value')
  assert.equal(existsSync(path), false, 'the unparsable bytes were left where the next save lands')
  const kept = `${path}.corrupt-2026-09-11T12-34-56-789Z`
  assert.equal(await readFile(kept, 'utf8'), '{ "global": { "temp',
    'the quarantined copy is not the original bytes')
  // Filesystem-safe: the stamp a Windows path cannot hold is the one with
  // colons in it, and this is the assertion that would go red if the ISO string
  // were used as it comes. Asserted on the **file name**, not on the path — the
  // first draft checked the path and went red on `C:\`, which is a colon
  // Windows requires rather than one it refuses.
  assert.equal(basename(kept).includes(':'), false, 'the quarantine name carries a colon')
  assert.equal(said.length, 1, 'the quarantine was silent')
  assert.match(said[0] ?? '', /could not be read as JSON/u)
  assert.ok((said[0] ?? '').includes(kept), 'the report does not name where the bytes went')
})

test('an absent file says nothing and an unreadable one does', async (t) => {
  const dir = await scratch(t)

  // The distinction every store in this package used to collapse. A first run
  // is routine and must not report; a directory where a file was expected is a
  // file that exists and whose contents the defaults are about to stand in for.
  const quiet: string[] = []
  assert.equal(await readJsonStore(join(dir, 'nothing.json'), m => { quiet.push(m) }), undefined)
  assert.deepEqual(quiet, [], 'a first run was reported as a problem')

  const said: string[] = []
  assert.equal(await readJsonStore(dir, m => { said.push(m) }), undefined)
  assert.equal(said.length, 1, 'a file that could not be read was passed over in silence')
  assert.match(said[0] ?? '', /could not be read/u)
  // Nothing is moved: the bytes may be perfectly good and only the read failed.
  assert.equal(existsSync(dir), true)
})

test('a second quarantine in the same millisecond does not overwrite the first', async (t) => {
  const dir = await scratch(t)
  const path = join(dir, 'favorites.json')
  const at = new Date('2026-09-11T00:00:00.000Z')

  await writeFile(path, 'first corruption', 'utf8')
  const one = await quarantineCorruptFile(path, at)
  await writeFile(path, 'second corruption', 'utf8')
  const two = await quarantineCorruptFile(path, at)

  assert.notEqual(one, two, 'the second quarantine reused the first one\'s name')
  assert.equal(await readFile(one ?? '', 'utf8'), 'first corruption',
    'the earlier evidence was destroyed by the later incident')
  assert.equal(await readFile(two ?? '', 'utf8'), 'second corruption')
})

test('a file that could not be set aside is reported as such, with the warning attached', async (t) => {
  const dir = await scratch(t)

  // The branch nobody hopes to reach, and the only one where the old behaviour
  // survives: the rename was refused, so the bytes are still at the path the
  // next `save()` writes to. Two different sentences, because they are two
  // different situations for whoever reads the report — one ends with where to
  // find the file, the other with a warning that it is about to go.
  const said: string[] = []
  const gone = join(dir, 'never-existed.json')
  assert.equal(await quarantineUnparsable(gone, 'Unexpected end of JSON input',
    message => { said.push(message) }), undefined)
  assert.equal(said.length, 1)
  assert.match(said[0] ?? '', /could not be set aside/u)
  assert.match(said[0] ?? '', /the next save will overwrite it/u)
  assert.equal(said[0]?.includes('it was kept as'), false,
    'a file that was not moved was reported as kept')
})
