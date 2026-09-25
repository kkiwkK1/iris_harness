import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

import ts from 'typescript'

import { ScriptVariableStore } from '../src/script-variables.ts'
import { tempDir } from './support/temp-dir.ts'

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
 * wiring structurally instead, on the parsed syntax tree of `index.ts` rather
 * than on its spelling: the `irisApp.storeDrains` effect must return an async
 * disposer that awaits all three drains, and must sit between the host lock
 * and the handlers so reverse disposal runs it after the handlers are revoked
 * and before the lock is released. The behavioural half — a debounced write
 * really is on disk when `fiber.dispose()` resolves — is
 * `apps/iris/tests/store-drains.test.ts`, which boots the composition.
 */

/** A throwaway store over its own file. */
async function store(t: TestContext): Promise<{ store: ScriptVariableStore, path: string }> {
  const dir = await tempDir(t, 'iris-script-vars-flush-')
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

/** Every `ctx.effect(factory, '<tag>')` call in `index.ts`, in source order. */
function effectsOf(sourceFile: ts.SourceFile): Array<{ tag: string, factory: ts.Expression, at: number }> {
  const effects: Array<{ tag: string, factory: ts.Expression, at: number }> = []
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === 'effect'
      && node.expression.expression.getText(sourceFile) === 'ctx'
    ) {
      const [factory, tag] = node.arguments
      if (factory !== undefined && tag !== undefined && ts.isStringLiteralLike(tag)) {
        effects.push({ tag: tag.text, factory, at: node.getStart(sourceFile) })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return effects
}

/** The `receiver.method` names of every call under a node. */
function callsUnder(node: ts.Node, sourceFile: ts.SourceFile): string[] {
  const calls: string[] = []
  const visit = (child: ts.Node): void => {
    if (ts.isCallExpression(child) && ts.isPropertyAccessExpression(child.expression)) {
      calls.push(child.expression.getText(sourceFile))
    }
    ts.forEachChild(child, visit)
  }
  visit(node)
  return calls
}

/** Whether any `await` occurs under a node (without descending into nested functions). */
function awaitsUnder(node: ts.Node): boolean {
  let found = false
  const visit = (child: ts.Node): void => {
    if (found) return
    if (ts.isAwaitExpression(child)) { found = true; return }
    if (child !== node && ts.isFunctionLike(child)) return
    ts.forEachChild(child, visit)
  }
  visit(node)
  return found
}

test('the dispose path awaits this flush, between the handlers and the lock', async () => {
  const path = join(import.meta.dirname, '..', 'src', 'index.ts')
  const sourceFile = ts.createSourceFile(path, await readFile(path, 'utf8'), ts.ScriptTarget.Latest, true)
  const effects = effectsOf(sourceFile)
  // A floor on what the walk found, so a broken walk cannot pass by finding nothing.
  assert.ok(effects.length >= 6, `found ${String(effects.length)} tagged ctx.effect calls in index.ts`)

  const tagged = (tag: string): { tag: string, factory: ts.Expression, at: number } => {
    const found = effects.filter(effect => effect.tag === tag)
    assert.equal(found.length, 1, `expected exactly one ctx.effect tagged '${tag}'`)
    return found[0]!
  }
  const lock = tagged('irisApp.hostLock')
  const drains = tagged('irisApp.storeDrains')
  const handlers = tagged('irisApp.handlers')

  // Reverse disposal: registered after the lock and before the handlers means
  // disposed after the handlers and before the lock.
  assert.ok(lock.at < drains.at && drains.at < handlers.at,
    'the drains must be registered after the host lock and before the handlers')

  // `() => async () => { … }`: the factory returns an async disposer, whose
  // promise Cordis awaits. A synchronous disposer that `void`-fires the flush
  // is exactly the shape this replaced.
  const factory = drains.factory
  assert.ok(ts.isArrowFunction(factory), 'the drain effect factory is not an arrow')
  const disposer = factory.body
  assert.ok(ts.isArrowFunction(disposer) || ts.isFunctionExpression(disposer),
    'the drain effect factory must return its disposer directly')
  assert.ok(disposer.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword) === true,
    'the drain disposer is not async, so dispose() cannot wait for it')
  assert.ok(awaitsUnder(disposer.body), 'the drain disposer never awaits')

  const calls = callsUnder(disposer, sourceFile)
  assert.ok(calls.includes('scriptVariables.flush'), 'the drain no longer flushes the script variables store — gap 4 is open again')
  // The symmetry is the point of the change: card storage's drain, beside it.
  assert.ok(calls.includes('cardStorage.flush'), 'card storage lost its own drain')
  assert.ok(calls.includes('systemPlugins.flushPluginData'), 'the plugins\' private stores lost their drain')

  // And no flush is fired and forgotten anywhere else in the composition.
  const voided: string[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isVoidExpression(node) && /\.(flush|flushPluginData)\(/.test(node.expression.getText(sourceFile))) {
      voided.push(node.getText(sourceFile))
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  assert.deepEqual(voided, [], 'a drain is void-fired, so dispose() resolves before it lands')
})
