import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import type { Context } from '@deepseek-ai/cordis'
import { boot } from '@deepseek-ai/dsh-app-boot'
import { HOST_LOCK_FILE } from '@iris/app-service'

/**
 * A booted host takes its data directory, and the second one does not start.
 *
 * `packages/iris-app-service/tests/host-lock.test.ts` pins the lock's own
 * semantics. That is necessary and not sufficient: the rule only protects
 * anything if the composition actually applies it, and the one thing a unit on
 * `acquireHostLock` cannot show is that `apply` calls it — before the stores
 * read, with the port the carrier bound, and with a disposer that gives the
 * directory back. So this file boots the real plugin twice.
 *
 * **Both hosts here are on `port: 0`.** That is the point. Upstream excludes a
 * second instance by port (`src/server-startup.js:238-240` on `EADDRINUSE`),
 * which says nothing at all about two processes on two ports sharing one
 * `--dataRoot` — the configuration that actually cost this repository three
 * rounds of misdiagnosis. Two ephemeral ports, one directory, refused.
 *
 * Every directory is an `mkdtemp`; nothing here goes near `apps/iris/data`.
 *
 * @module apps/iris/tests/host-lock
 */

const FIXTURE = fileURLToPath(new URL('./fixtures/host-lock.cordis.yml', import.meta.url))

/** Contexts to dispose and directories to remove, whatever each test did. */
const open: Context[] = []
const made: string[] = []

after(async () => {
  for (const ctx of open.reverse()) await ctx.fiber.dispose().catch(() => undefined)
  // Windows keeps a handle inside the profile for a moment after disposal.
  for (const dir of made) await rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 })
})

/** A data directory nobody else has, with the profile the app service expects. */
async function dataDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'iris-lockboot-'))
  made.push(dir)
  await mkdir(join(dir, 'default-user', 'characters'), { recursive: true })
  return dir
}

/** Boot the fixture against one data directory. */
async function host(name: string, dir: string): Promise<Context> {
  process.env.IRIS_TEST_LOCK_DATA_DIR = dir
  const ctx = await boot(name, FIXTURE)
  open.push(ctx)
  return ctx
}

test('a booted host holds its data directory, and a second one on the same directory does not start', async () => {
  const dir = await dataDir()
  const first = await host('iris-lock-first', dir)

  const lockPath = join(dir, HOST_LOCK_FILE)
  assert.ok((await stat(lockPath)).isFile(), 'the composition must take the lock, not just export the function')
  const record = JSON.parse(await readFile(lockPath, 'utf8')) as { pid?: number, port?: number }
  assert.equal(record.pid, process.pid)
  assert.equal(record.port, first.webServer.port,
    'the recorded port must be the one the carrier bound — the configured one sends the reader nowhere')

  await assert.rejects(
    () => host('iris-lock-second', dir),
    (error: Error) => {
      // The boot wraps the plugin's throw, so the sentence is inside the message
      // rather than being the whole of it.
      assert.ok(error.message.includes('already open by another host'), error.message)
      assert.ok(error.message.includes(lockPath), 'the refusal must name the lock file')
      assert.ok(error.message.includes(`pid ${String(process.pid)}`), 'the refusal must name the holder')
      assert.ok(error.message.includes(`port ${String(first.webServer.port)}`), 'the refusal must name the port')
      assert.ok(error.message.includes('IRIS_DATA_DIR'), 'the refusal must say how to proceed')
      return true
    },
  )

  // The refused host must not have damaged the holder's lock on its way out.
  const after = JSON.parse(await readFile(lockPath, 'utf8')) as { port?: number }
  assert.equal(after.port, first.webServer.port)
})

test('a second host on a different data directory starts, on its own port', async () => {
  const mine = await dataDir()
  const theirs = await dataDir()

  const a = await host('iris-lock-a', mine)
  const b = await host('iris-lock-b', theirs)

  assert.notEqual(a.webServer.port, b.webServer.port, 'two ephemeral ports, so the refusal above was about the directory')
  assert.ok((await stat(join(mine, HOST_LOCK_FILE))).isFile())
  assert.ok((await stat(join(theirs, HOST_LOCK_FILE))).isFile())
})

test('an orderly shutdown gives the directory back, and the next host takes it fresh', async () => {
  const dir = await dataDir()
  const first = await host('iris-lock-release', dir)
  const lockPath = join(dir, HOST_LOCK_FILE)
  assert.ok((await stat(lockPath)).isFile())

  await first.fiber.dispose()
  open.splice(open.indexOf(first), 1)
  await assert.rejects(() => stat(lockPath), 'disposing the fiber must release the lock')

  // Fresh, not a takeover: a clean stop leaves nothing to report.
  const second = await host('iris-lock-again', dir)
  assert.equal((JSON.parse(await readFile(lockPath, 'utf8')) as { pid?: number }).pid, process.pid)
  assert.ok(second.webServer.port > 0)
})

test('the boot that takes the directory also sweeps the temporaries a dead host left in it', async () => {
  const dir = await dataDir()
  // The debris of the 2026-09-11 incident, in the current spelling: a world
  // book's temporary, named for a process id that cannot exist anywhere this
  // suite runs — past every pid_max, and odd where Windows ids are multiples
  // of four. `packages/iris-app-service` tests the sweep's rules; this one
  // pins that the composition runs it, the way the lock tests above pin that
  // `apply` takes the lock rather than merely exporting it.
  const worlds = join(dir, 'default-user', 'worlds')
  await mkdir(worlds, { recursive: true })
  const debris = join(worlds, `扣扣审判1.0.json.2147483647.${'ab'.repeat(8)}.tmp`)
  await writeFile(debris, '{}')

  await host('iris-lock-sweep', dir)

  assert.equal(existsSync(debris), false,
    'the stale temporary survived a boot that took the data directory')
  assert.ok((await stat(join(dir, HOST_LOCK_FILE))).isFile(),
    'the sweep disturbed the lock it runs beside')
})
