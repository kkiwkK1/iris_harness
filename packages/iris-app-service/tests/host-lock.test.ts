import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  acquireHostLock,
  describeHeldLock,
  HOST_LOCK_FILE,
  isPidAlive,
  readLockRecord,
} from '../src/host-lock.ts'

/**
 * One host per data directory.
 *
 * The property under test is not "a file appears". It is that the **second**
 * host on one directory does not start, and that the one case where refusing
 * would be wrong — the previous host is gone and only its file is left — is
 * distinguished by something better than a timestamp.
 *
 * Every temporary directory here is an `mkdtemp`. Nothing in this file may
 * touch `apps/iris/data`: that directory belongs to whatever host is running on
 * this machine, and creating a lock in it is the incident, not the test.
 *
 * @module @iris/app-service/tests/host-lock
 */

/** A fresh, empty data directory nobody else has. */
async function dataDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'iris-hostlock-'))
}

/** Tidy up, with the retry Windows needs for a handle that closes a beat late. */
async function drop(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 })
}

/**
 * A process id that is certainly **not** running, measured rather than guessed.
 *
 * A number picked out of the air (99999) is a guess that is wrong on any busy
 * machine, and a wrong guess here does not fail the test — it silently turns
 * the stale case into the held case and the assertion passes for the wrong
 * reason. So: spawn a child, wait for its exit, and reuse its id. The id is
 * free at that moment by construction, and the window before the kernel
 * recycles it is the whole test.
 * @returns a pid that `isPidAlive` answers false for.
 */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' })
  const pid = child.pid
  assert.ok(pid !== undefined, 'the child did not start, so this test has no dead pid to use')
  await new Promise<void>(resolve => { child.once('exit', () => { resolve() }) })
  // The measurement, not an assumption: if this is ever false the rest of the
  // file is testing the live branch under a stale name.
  assert.equal(isPidAlive(pid), false, `pid ${String(pid)} exited but still probes as alive`)
  return pid
}

test('a fresh directory is taken, and the file says who took it', async () => {
  const dir = await dataDir()
  try {
    const lock = await acquireHostLock(dir, { port: 8123 })
    assert.equal(lock.path, join(dir, HOST_LOCK_FILE))
    assert.equal(lock.takeover, undefined, 'a directory nobody held is not a takeover')

    const written = readLockRecord(await readFile(lock.path, 'utf8'))
    assert.ok(written !== undefined, 'the lock file must parse back as a record')
    assert.equal(written.pid, process.pid)
    assert.equal(written.port, 8123, 'the bound port is recorded, because the refusal has to name it')
    assert.ok(written.hostname.length > 0)
    assert.ok(!Number.isNaN(Date.parse(written.startedAt)), 'startedAt must be a readable moment')
  } finally {
    await drop(dir)
  }
})

test('a second host on the same directory is refused, and the sentence says where, who, which port and what to do', async () => {
  const dir = await dataDir()
  try {
    // The first holder's pid is this process's, which is alive by construction —
    // the only pid a test can be certain about in the positive direction.
    const first = await acquireHostLock(dir, { port: 8787 })

    await assert.rejects(
      () => acquireHostLock(dir, { port: 8790 }),
      (error: Error) => {
        assert.ok(error.message.includes(first.path), 'the refusal must name the lock file')
        assert.ok(error.message.includes(`pid ${String(process.pid)}`), 'the refusal must name the holder')
        assert.ok(error.message.includes('port 8787'), 'the refusal must name the port the holder says it bound')
        assert.ok(error.message.includes('IRIS_DATA_DIR'), 'the refusal must say how to proceed')
        assert.ok(error.message.includes('Stop that host'), 'the refusal must offer the other way out too')
        return true
      },
    )

    // Refused, not overwritten: the holder's own record is still what is there.
    const still = readLockRecord(await readFile(first.path, 'utf8'))
    assert.equal(still?.port, 8787, 'a refused host must not have rewritten the lock it was refused by')
  } finally {
    await drop(dir)
  }
})

test('a lock left by a process that is gone is stale: taken over, and said out loud', async () => {
  const dir = await dataDir()
  try {
    const gone = await deadPid()
    await writeFile(join(dir, HOST_LOCK_FILE), JSON.stringify({
      pid: gone, port: 8787, startedAt: '2026-09-10T00:00:00.000Z', hostname: 'somewhere',
    }), 'utf8')

    const lock = await acquireHostLock(dir, { port: 8790 })
    assert.ok(lock.takeover !== undefined, 'taking a stale lock over in silence is how a crash goes unnoticed')
    assert.ok(lock.takeover.includes(String(gone)), 'the takeover line must name the process that left it')
    assert.ok(lock.takeover.includes(lock.path), 'the takeover line must name the file')

    const now = readLockRecord(await readFile(lock.path, 'utf8'))
    assert.equal(now?.pid, process.pid, 'the lock must now be ours')
    assert.equal(now.port, 8790)
  } finally {
    await drop(dir)
  }
})

test('EPERM on the liveness probe reads as alive, not as gone', async () => {
  const dir = await dataDir()
  try {
    const gone = await deadPid()
    await writeFile(join(dir, HOST_LOCK_FILE), JSON.stringify({
      pid: gone, port: 8787, startedAt: '2026-09-10T00:00:00.000Z', hostname: 'somewhere',
    }), 'utf8')

    // `isPidAlive` with an injected probe, because EPERM cannot be produced on
    // demand: it needs a live process owned by another user.
    assert.equal(isPidAlive(gone, () => { throw Object.assign(new Error('nope'), { code: 'EPERM' }) }), true,
      'EPERM means the process exists and is not ours to signal — that is alive')
    assert.equal(isPidAlive(gone, () => { throw Object.assign(new Error('nope'), { code: 'ESRCH' }) }), false,
      'ESRCH is the only answer that means gone')

    // And end to end: an acquire whose probe says EPERM refuses, even though
    // the recorded pid really is dead.
    await assert.rejects(
      () => acquireHostLock(dir, { isAlive: () => isPidAlive(gone, () => { throw Object.assign(new Error('nope'), { code: 'EPERM' }) }) }),
      /already open by another host/u,
    )
  } finally {
    await drop(dir)
  }
})

test('pid 0 and a negative pid are refused rather than probed', () => {
  // `kill(0, 0)` addresses the calling process *group* on POSIX and would
  // answer "alive" for a lock file that names nobody.
  assert.equal(isPidAlive(0), false)
  assert.equal(isPidAlive(-1), false)
  assert.equal(isPidAlive(1.5), false)
})

test('a lock file with garbage inside is stale, and the takeover says it did not parse', async () => {
  const dir = await dataDir()
  try {
    await writeFile(join(dir, HOST_LOCK_FILE), '{ half a wri', 'utf8')
    assert.equal(readLockRecord('{ half a wri'), undefined)
    assert.equal(readLockRecord('{"port":8787}'), undefined, 'a record with no pid names no process to probe')
    assert.equal(readLockRecord('"a string"'), undefined)

    const lock = await acquireHostLock(dir, { port: 8790 })
    assert.ok(lock.takeover !== undefined, 'garbage must be reported, not passed over')
    assert.ok(lock.takeover.includes('did not parse'), `the line must say what was wrong: ${lock.takeover}`)
    assert.equal(readLockRecord(await readFile(lock.path, 'utf8'))?.pid, process.pid)
  } finally {
    await drop(dir)
  }
})

test('release removes the lock, and a host that no longer holds it removes nothing', async () => {
  const dir = await dataDir()
  try {
    const lock = await acquireHostLock(dir, { port: 8787 })
    await lock.release()
    await assert.rejects(() => stat(lock.path), 'an orderly shutdown gives the directory back')

    // Twice is a no-op, because a disposer can run after a manual release.
    await lock.release()

    // Someone else now holds it; our stale handle must not delete their file.
    const other = await acquireHostLock(dir, { port: 8790, pid: 4242, now: () => new Date('2026-09-11T00:00:00.000Z') })
    await lock.release()
    assert.equal(readLockRecord(await readFile(other.path, 'utf8'))?.pid, 4242,
      'a released host must not delete the lock of the host that took the directory after it')
    await other.release()
  } finally {
    await drop(dir)
  }
})

test('a recycled pid does not let a shutdown delete another host\'s lock', async () => {
  const dir = await dataDir()
  try {
    const first = await acquireHostLock(dir, { pid: 777, now: () => new Date('2026-09-11T01:00:00.000Z') })
    await first.release()
    // Same pid, different start: the operating system gave the id back.
    const second = await acquireHostLock(dir, { pid: 777, now: () => new Date('2026-09-11T02:00:00.000Z') })
    await first.release()
    assert.equal(readLockRecord(await readFile(second.path, 'utf8'))?.startedAt, '2026-09-11T02:00:00.000Z',
      'startedAt is the half of the identity that survives a recycled pid')
  } finally {
    await drop(dir)
  }
})

test('the refusal sentence is legible when the lock records no port', () => {
  const sentence = describeHeldLock('C:\\data\\host.lock', {
    pid: 1234, startedAt: '2026-09-11T00:00:00.000Z', hostname: 'box',
  })
  assert.ok(sentence.includes('an unrecorded port'), sentence)
  assert.ok(sentence.includes('pid 1234'), sentence)
  assert.ok(sentence.includes('C:\\data\\host.lock'), sentence)
  // No flag is offered, because there is none: an escape hatch would be taken
  // in exactly the situation that produced the incident.
  assert.ok(!/--?[a-z-]*(force|allow|shared)/iu.test(sentence),
    `the refusal must not advertise an override: ${sentence}`)
})

test('the lock is created in the data directory even when it does not exist yet', async () => {
  const dir = await dataDir()
  try {
    const nested = join(dir, 'not', 'made', 'yet')
    const lock = await acquireHostLock(nested)
    assert.equal(lock.path, join(nested, HOST_LOCK_FILE))
    assert.ok((await stat(lock.path)).isFile())
  } finally {
    await drop(dir)
  }
})
