import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { SystemPluginSnapshot } from '@iris/protocol'
import { testClient, recorder } from './helpers.ts'

function plugin(snapshot: SystemPluginSnapshot, id: string) {
  const found = snapshot.plugins.find(row => row.id === id)
  assert.ok(found, `snapshot omitted ${id}`)
  return found
}

test('existing fake profiles start with both bundled plugins active', async () => {
  const client = testClient()
  const snapshot = await client.call('plugin.list', {})

  assert.deepEqual(snapshot.plugins.map(row => row.id), ['tavern-helper', 'mvu'])
  assert.equal(plugin(snapshot, 'tavern-helper').status, 'enabled')
  assert.equal(plugin(snapshot, 'mvu').status, 'enabled')
  assert.deepEqual(plugin(snapshot, 'mvu').dependencies, ['tavern-helper'])
  client.dispose()
})

test('an enabled dependent blocks dependency disable, reload and uninstall', async () => {
  const client = testClient()
  const before = await client.call('plugin.list', {})

  for (const method of ['plugin.disable', 'plugin.reload', 'plugin.uninstall'] as const) {
    await assert.rejects(
      () => client.call(method, { id: 'tavern-helper' }),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, 'invalid-request')
        assert.match((error as Error).message, /disable MVU first/)
        return true
      },
    )
  }

  assert.deepEqual(await client.call('plugin.list', {}), before, 'a refused operation changed the snapshot')
  client.dispose()
})

test('enabling MVU reinstalls and enables TavernHelper before MVU', async () => {
  const client = testClient()
  await client.call('plugin.uninstall', { id: 'mvu' })
  await client.call('plugin.disable', { id: 'tavern-helper' })
  await client.call('plugin.uninstall', { id: 'tavern-helper' })

  const recorded = recorder(client)
  const final = await client.call('plugin.enable', { id: 'mvu' })
  const snapshots = recorded.events
    .filter(event => event.type === 'plugins.changed')
    .map(event => event.snapshot)

  const thEnabled = snapshots.findIndex(snapshot => plugin(snapshot, 'tavern-helper').status === 'enabled')
  const mvuEnabling = snapshots.findIndex(snapshot => plugin(snapshot, 'mvu').status === 'enabling')
  assert.ok(thEnabled >= 0, 'TavernHelper never became enabled')
  assert.ok(mvuEnabling > thEnabled, 'MVU started before TavernHelper finished enabling')
  assert.equal(plugin(final, 'tavern-helper').status, 'enabled')
  assert.equal(plugin(final, 'mvu').status, 'enabled')
  assert.ok(snapshots.every((snapshot, index) => index === 0 || snapshot.revision > snapshots[index - 1]!.revision))

  recorded.stop()
  client.dispose()
})

test('uninstall and reinstall leave conversation data intact', async () => {
  const client = testClient()
  const before = await client.call('chat.list', {})

  await client.call('plugin.uninstall', { id: 'mvu' })
  const removed = await client.call('plugin.list', {})
  assert.equal(plugin(removed, 'mvu').status, 'not-installed')
  await client.call('plugin.install', { id: 'mvu' })

  assert.deepEqual(await client.call('chat.list', {}), before)
  assert.equal(plugin(await client.call('plugin.list', {}), 'mvu').status, 'disabled')
  client.dispose()
})

test('reload exposes teardown and activation without duplicating the catalog', async () => {
  const client = testClient()
  const recorded = recorder(client)

  const final = await client.call('plugin.reload', { id: 'mvu' })
  const statuses = recorded.events
    .filter(event => event.type === 'plugins.changed')
    .map(event => plugin(event.snapshot, 'mvu').status)

  assert.deepEqual(statuses, ['disabling', 'enabling', 'enabled'])
  assert.equal(final.plugins.filter(row => row.id === 'mvu').length, 1)
  recorded.stop()
  client.dispose()
})

test('the fake refuses ids outside its bundled catalog', async () => {
  const client = testClient()

  await assert.rejects(
    () => client.call('plugin.install', { id: 'imaginary-marketplace-package' }),
    (error: unknown) => (error as { code?: string }).code === 'not-found',
  )
  assert.equal((await client.call('plugin.list', {})).plugins.length, 2)
  client.dispose()
})
