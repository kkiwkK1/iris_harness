import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

import { ScriptVariableStore } from '../src/script-variables.ts'

/**
 * The unload path: the queued writes land, and nothing writes after them.
 *
 * `script-variables.ts` serialises every write through one chain, the same
 * shape `card-storage.ts` debounces — but only card storage had a recovery
 * point in the plugin's dispose (`notes/AUDIT-CORDIS.md` §3, gap 4). These
 * tests hold the two facts the added `flush` is for: the last write reaches
 * the file without anybody waiting for it first, and a write that arrives
 * after the flush is refused — the chosen half of that bargain, because a
 * write taken into memory but never persisted lets a script believe it saved,
 * which is the silence every other failure in this store refuses to produce.
 *
 * Whether the dispose path actually *calls* the flush is a question about one
 * line inside the plugin body, and the plugin body only runs inside a booted
 * composition — no test in this package mounts one. The last test checks the
 * wiring structurally instead, the way `config-wiring.test.ts` does for
 * exactly this class of invisible failure.
 */

/** A throwaway store over its own file. */
async function store(t: TestContext): Promise<{ store: ScriptVariableStore, path: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'iris-script-vars-flush-'))
  t.after(async () => { await rm(dir, { recursive: true, force: true }) })
  const path = join(dir, 'script-variables.json')
  return { store: new ScriptVariableStore(path), path }
}

test('a write nobody waited for is on disk after flush', async (t) => {
  const { store: variables, path } = await store(t)
  const backend = variables.backendFor(await variables.open('aria', undefined))

  // Written and abandoned, the way a script's write actually happens: the
  // backend is synchronous and the persistence is not, so by the time the
  // host unloads there is normally a write in the chain that its caller has
  // long since stopped watching.
  backend.write({ type: 'script', script_id: 'panel' }, { 进度: 9 })
  await variables.flush()

  const saved = JSON.parse(await readFile(path, 'utf8')) as { aria?: Record<string, { 进度?: number }> }
  assert.equal(saved.aria?.panel?.进度, 9, 'the queued write did not reach the file before the flush returned')
})

test('flushing an idle store writes nothing, as not having stored anything implies', async (t) => {
  const { store: variables, path } = await store(t)
  await variables.open('aria', undefined)

  await variables.flush()
  // The file existing is what says "a script stored something" — the same
  // rule `CardStorageStore.clear` states for itself. A dispose over a host
  // that never wrote must not mint it.
  assert.equal(existsSync(path), false, 'an idle store created its file on flush')
})

test('a write after the flush is refused, out loud', async (t) => {
  const { store: variables, path } = await store(t)
  const backend = variables.backendFor(await variables.open('aria', undefined))
  backend.write({ type: 'script', script_id: 'panel' }, { 进度: 9 })
  await variables.flush()
  const before = await readFile(path, 'utf8')

  // Refused rather than taken into memory: a table that accepts the write and
  // a file that never sees it is a script reading back a save that does not
  // exist. The refusal is the same wire code every other refusal in this
  // store uses, so a frame still holding a backend learns the write did not
  // happen instead of silently losing it at the next restart.
  assert.throws(
    () => backend.write({ type: 'script', script_id: 'panel' }, { 进度: 10, 追记: true }),
    (error: unknown) => (error as { code?: string }).code === 'invalid-request',
  )
  // And neither half of the refusal lies: the file did not grow the write,
  // and the memory the next read would see did not either.
  assert.equal(await readFile(path, 'utf8'), before, 'the refused write reached the file anyway')
  assert.deepEqual(backend.read({ type: 'script', script_id: 'panel' }), { 进度: 9 })
})

test('the dispose path calls this flush, not merely describes it', async (t) => {
  const source = await readFile(join(import.meta.dirname, '..', 'src', 'index.ts'), 'utf8')
  // The disposer is the one `return () => {` in the file, and the effect's
  // tag ends the slice — a mention anywhere else in the plugin body (a
  // comment, a different store's setup) is not the wiring this check exists
  // for. Verified to have teeth by removing the call: this goes red.
  const at = source.indexOf('return () => {')
  assert.ok(at > 0, 'the handlers effect no longer returns a disposer')
  const dispose = source.slice(at, source.indexOf("}, 'irisApp.handlers'", at))
  assert.match(
    dispose,
    /void scriptVariables\.flush\(\)\.catch\(/,
    'the dispose no longer drains the script variables store — gap 4 is open again',
  )
  // The symmetry is the point of the change: card storage's drain, beside it.
  assert.match(dispose, /void cardStorage\.flush\(\)\.catch\(/, 'card storage lost its own drain')
})
