import assert from 'node:assert/strict'
import { mkdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import type { Context } from '@deepseek-ai/cordis'
import { boot } from '@deepseek-ai/dsh-app-boot'
import { HOST_LOCK_FILE } from '@iris/app-service'
import { removeTempDir, tempDirOwned } from '../../../packages/iris-app-service/tests/support/temp-dir.ts'

/**
 * Shutdown waits for the store drains, and gives the directory back only after.
 *
 * Card storage debounces its writes (`WRITE_DEBOUNCE_MS`, 400 ms), so a write a
 * card made just before the host stops exists only in memory until the drain
 * runs. The drain used to be `void`-fired from a synchronous disposer:
 * `fiber.dispose()` resolved, the lock was released and `bin.ts` exited with
 * the write still in flight. This boots the real composition (the lock test's
 * fixture), writes over the wire, disposes at once, and reads the file.
 *
 * Every directory comes from `tempDirOwned`; nothing here goes near `apps/iris/data`.
 *
 * @module apps/iris/tests/store-drains
 */

const FIXTURE = fileURLToPath(new URL('./fixtures/host-lock.cordis.yml', import.meta.url))

const open: Context[] = []
const made: string[] = []

after(async () => {
  for (const ctx of open.reverse()) await ctx.fiber.dispose().catch(() => undefined)
  // `tempDirOwned`, not `tempDir`: a booted host holds its data directory, so
  // removal has to wait until the fiber above is disposed, which a `t.after`
  // registered when the directory was made would not.
  for (const dir of made) await removeTempDir(dir)
})

test('a debounced card-storage write is on disk when dispose resolves, and the lock is released after it', async () => {
  const dir = await tempDirOwned('iris-drains-')
  made.push(dir)
  await mkdir(join(dir, 'default-user', 'characters'), { recursive: true })
  process.env.IRIS_TEST_LOCK_DATA_DIR = dir
  const ctx = await boot('iris-store-drains', FIXTURE)
  open.push(ctx)

  const response = await fetch(`http://127.0.0.1:${String(ctx.webServer.port)}/iris/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      id: 'drain-1',
      method: 'storage.set',
      params: { characterId: 'aria', key: 'progress', value: 'chapter-9' },
    }),
  })
  const frame = await response.json() as { ok: boolean, error?: { message: string } }
  assert.equal(frame.ok, true, frame.error?.message)

  const file = join(dir, 'default-user', 'card-storage.json')
  // The premise of the test: the write is still inside the debounce window,
  // so only the drain can put it on disk.
  await assert.rejects(() => stat(file), 'the write reached disk before dispose, so this proves nothing about the drain')

  await ctx.fiber.dispose()
  open.splice(open.indexOf(ctx), 1)

  const saved = JSON.parse(await readFile(file, 'utf8')) as Record<string, { value?: string }>
  assert.equal(saved['progress']?.value, 'chapter-9', 'dispose resolved before the card-storage drain landed')
  await assert.rejects(() => stat(join(dir, HOST_LOCK_FILE)), 'disposing the fiber must still release the lock')
})
