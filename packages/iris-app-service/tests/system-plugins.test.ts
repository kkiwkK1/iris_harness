import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

import { Context } from '@deepseek-ai/cordis'

import { AppError } from '../src/errors.ts'
import {
  SystemPluginRuntime,
  type SystemPluginDefinition,
} from '../src/system-plugins.ts'

interface Harness {
  dir: string
  file: string
  context: Context
  runtime: SystemPluginRuntime
}

async function harness(
  t: TestContext,
  definitions: readonly SystemPluginDefinition[],
  defaultEnabled: readonly string[] = definitions.map(row => row.id),
): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), 'iris-system-plugins-'))
  const file = join(dir, 'system-plugins.json')
  const context = new Context()
  const runtime = new SystemPluginRuntime({ context, file, definitions, defaultEnabled })
  t.after(async () => {
    await runtime.dispose()
    await rm(dir, { recursive: true, force: true })
  })
  return { dir, file, context, runtime }
}

function definition(
  id: string,
  hooks: { activate?: () => void, dispose?: () => void } = {},
  dependencies: readonly string[] = [],
): SystemPluginDefinition {
  return {
    id,
    name: id.toUpperCase(),
    description: `${id} test plugin`,
    version: '1.0.0',
    apiVersion: 1,
    dependencies,
    activate(scope) {
      hooks.activate?.()
      scope.provide('value', { id, revision: scope.revision })
      return () => { hooks.dispose?.() }
    },
  }
}

function row(runtime: SystemPluginRuntime, id: string) {
  const found = runtime.snapshot().plugins.find(plugin => plugin.id === id)
  assert.ok(found !== undefined, `missing plugin ${id}`)
  return found
}

async function waitFor(check: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    if (check()) return
    await new Promise<void>(resolve => { setTimeout(resolve, 1) })
  }
  assert.fail(`timed out waiting for ${label}`)
}

test('registered implementations are real Cordis capabilities and reload without duplicates', async (t) => {
  let active = 0
  let peak = 0
  let disposed = 0
  const plugin = definition('one', {
    activate: () => { active += 1; peak = Math.max(peak, active) },
    dispose: () => { active -= 1; disposed += 1 },
  })
  const value = await harness(t, [plugin])
  await value.runtime.initialize()

  const first = value.runtime.capability<{ revision: number }>('one', 'value')
  assert.equal(active, 1)
  assert.equal(first?.revision, value.runtime.snapshot().revision)

  await value.runtime.reload('one')
  const second = value.runtime.capability<{ revision: number }>('one', 'value')
  assert.equal(active, 1)
  assert.equal(peak, 1, 'reload activated before the old Cordis fiber disposed')
  assert.equal(disposed, 1)
  assert.notEqual(second, first, 'reload retained the old capability object')
  assert.equal(second?.revision, value.runtime.snapshot().revision)
})

test('startup repairs and persists an enabled dependency closure at the boot revision', async (t) => {
  const defs = [definition('helper'), definition('dependent', {}, ['helper'])]
  const value = await harness(t, defs, [])
  await writeFile(value.file, JSON.stringify({
    version: 1,
    revision: 9,
    plugins: {
      helper: { installed: false, enabled: false },
      dependent: { installed: true, enabled: true },
      unavailableLater: { installed: true, enabled: false },
    },
  }))

  await value.runtime.initialize()
  assert.equal(value.runtime.snapshot().revision, 10)
  assert.equal(row(value.runtime, 'helper').status, 'enabled')
  assert.equal(row(value.runtime, 'dependent').status, 'enabled')

  const stored = JSON.parse(await readFile(value.file, 'utf8')) as {
    revision: number
    plugins: Record<string, { installed: boolean, enabled: boolean }>
  }
  assert.equal(stored.revision, 10)
  assert.deepEqual(stored.plugins['helper'], { installed: true, enabled: true })
  assert.deepEqual(
    stored.plugins['unavailableLater'],
    { installed: true, enabled: false },
    'an unknown persisted id was discarded',
  )
})

test('dependency removal and reload name the enabled dependent that must stop first', async (t) => {
  const value = await harness(t, [definition('helper'), definition('dependent', {}, ['helper'])])
  await value.runtime.initialize()

  for (const operation of [
    () => value.runtime.disable('helper'),
    () => value.runtime.uninstall('helper'),
    () => value.runtime.reload('helper'),
  ]) {
    await assert.rejects(operation, (error: unknown) => {
      assert.ok(error instanceof AppError)
      assert.equal(error.code, 'busy')
      assert.match(error.message, /DEPENDENT/u)
      assert.match(error.message, /disable DEPENDENT first/u)
      return true
    })
  }
  assert.equal(row(value.runtime, 'helper').status, 'enabled')
})

test('a disable closes admission then drains the old incarnation before succeeding', async (t) => {
  let disposed = false
  const value = await harness(t, [definition('one', { dispose: () => { disposed = true } })])
  await value.runtime.initialize()
  const revision = value.runtime.snapshot().revision
  const lease = value.runtime.lease('one', revision)

  let disableSettled = false
  const disabling = value.runtime.disable('one').then(() => { disableSettled = true })
  await waitFor(() => row(value.runtime, 'one').status === 'disabling', 'disable admission to close')

  assert.equal(row(value.runtime, 'one').status, 'disabling')
  assert.equal(disableSettled, false)
  assert.equal(disposed, false)
  assert.equal(lease.isCurrent(), true, 'closing admission invalidated work already admitted')
  lease.assertCurrent()
  assert.throws(() => value.runtime.lease('one', revision), /disabled/u)

  // This stands in for the commit edge of work that was already admitted.
  // Disable cannot report success until that work releases its incarnation.
  lease.release()
  await disabling
  assert.equal(disableSettled, true)
  assert.equal(disposed, true)
  assert.equal(row(value.runtime, 'one').status, 'disabled')
  assert.equal(lease.isCurrent(), false)
  assert.throws(() => lease.assertCurrent(), /stale/u)
})

test('activation failure removes partial capabilities and does not block an independent plugin', async (t) => {
  const broken: SystemPluginDefinition = {
    id: 'broken', name: 'Broken', description: 'fails', version: '1', apiVersion: 1,
    activate(scope) {
      scope.provide('partial', { leaked: true })
      throw new Error('activation exploded')
    },
  }
  const value = await harness(t, [broken, definition('healthy')])
  await value.runtime.initialize()

  assert.equal(row(value.runtime, 'broken').status, 'error')
  assert.match(row(value.runtime, 'broken').error ?? '', /activation exploded/u)
  assert.equal(value.context.get('iris.system-plugin:broken:partial'), undefined)
  assert.equal(row(value.runtime, 'healthy').status, 'enabled')

  const stored = JSON.parse(await readFile(value.file, 'utf8')) as {
    plugins: Record<string, { enabled: boolean }>
  }
  assert.equal(stored.plugins['broken']?.enabled, false)
  assert.equal(stored.plugins['healthy']?.enabled, true)
})

test('corrupt existing preferences are retained and every capability fails closed', async (t) => {
  const value = await harness(t, [definition('one')])
  const bytes = '{ this is not json'
  await writeFile(value.file, bytes)
  const snapshot = await value.runtime.initialize()

  assert.equal(await readFile(value.file, 'utf8'), bytes)
  assert.equal(snapshot.plugins[0]?.installed, true)
  assert.equal(snapshot.plugins[0]?.enabled, false)
  assert.equal(snapshot.plugins[0]?.status, 'error')
  assert.equal(value.runtime.capability('one', 'value'), undefined)
  await assert.rejects(() => value.runtime.enable('one'), /file was retained/u)
})

test('a throwing change observer cannot roll back or reject a durable transition', async (t) => {
  const reports: Error[] = []
  const dir = await mkdtemp(join(tmpdir(), 'iris-system-plugin-listener-'))
  const runtime = new SystemPluginRuntime({
    context: new Context(),
    file: join(dir, 'system-plugins.json'),
    definitions: [definition('one')],
    defaultEnabled: [],
    onError: error => { reports.push(error) },
  })
  t.after(async () => {
    await runtime.dispose()
    await rm(dir, { recursive: true, force: true })
  })
  await runtime.initialize()
  runtime.onChange(() => { throw new Error('observer exploded') })

  await runtime.enable('one')
  assert.equal(row(runtime, 'one').status, 'enabled')
  assert.match(reports.at(-1)?.message ?? '', /observer exploded/u)
})
