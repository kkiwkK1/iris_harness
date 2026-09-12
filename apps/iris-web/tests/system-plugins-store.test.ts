import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { ChatView, IrisClient, IrisEvent, SystemPluginSnapshot } from '@iris/protocol'
import { createIrisStore } from '../src/client/store.ts'

const source = { transport: 'fake' as const, origin: 'plugin store test' }

function snapshot(revision: number, status: 'disabled' | 'enabling' | 'enabled' = 'enabled'): SystemPluginSnapshot {
  return {
    revision,
    plugins: [{
      id: 'tavern-helper',
      name: 'TavernHelper',
      description: 'Compatibility APIs for community cards.',
      version: '1.0.0',
      apiVersion: 1,
      dependencies: [],
      installed: true,
      enabled: status === 'enabled',
      status,
    }],
  }
}

function controlledClient(initial: SystemPluginSnapshot): {
  client: IrisClient
  setListed: (value: SystemPluginSnapshot) => void
  push: (event: IrisEvent) => void
  reconnect: () => void
  pluginLists: () => number
  deferNextList: () => (value: SystemPluginSnapshot) => void
  deferNextEnable: () => (value: SystemPluginSnapshot) => void
} {
  let listed = initial
  let lists = 0
  let nextList: Promise<SystemPluginSnapshot> | undefined
  let nextEnable: Promise<SystemPluginSnapshot> | undefined
  const eventListeners = new Set<(event: IrisEvent) => void>()
  const connectionListeners = new Set<(connected: boolean) => void>()
  const empty: ChatView = { chatId: 'unused', title: 'unused', messages: [] }
  const client: IrisClient = {
    connected: true,
    subscribe(listener) {
      eventListeners.add(listener)
      return () => { eventListeners.delete(listener) }
    },
    onConnectionChange(listener) {
      connectionListeners.add(listener)
      return () => { connectionListeners.delete(listener) }
    },
    async call(method) {
      if (method === 'plugin.list') {
        lists += 1
        const delayed = nextList
        nextList = undefined
        return (delayed === undefined ? listed : await delayed) as never
      }
      if (method === 'plugin.enable') {
        const delayed = nextEnable
        nextEnable = undefined
        if (delayed !== undefined) return await delayed as never
        eventListeners.forEach(listener => listener({ type: 'plugins.changed', snapshot: snapshot(8) }))
        return snapshot(7, 'enabling') as never
      }
      if (method === 'chat.list') return { chats: [] } as never
      if (method === 'character.list') return { characters: [] } as never
      if (method === 'settings.get') return { settings: { provider: 'p', model: 'm' } } as never
      if (method === 'connection.list') return { profiles: [] } as never
      return { view: empty } as never
    },
  }
  return {
    client,
    setListed: value => { listed = value },
    push: event => eventListeners.forEach(listener => listener(event)),
    reconnect: () => {
      connectionListeners.forEach(listener => listener(false))
      connectionListeners.forEach(listener => listener(true))
    },
    pluginLists: () => lists,
    deferNextList: () => {
      let resolve!: (value: SystemPluginSnapshot) => void
      nextList = new Promise<SystemPluginSnapshot>(done => { resolve = done })
      return resolve
    },
    deferNextEnable: () => {
      let resolve!: (value: SystemPluginSnapshot) => void
      nextEnable = new Promise<SystemPluginSnapshot>(done => { resolve = done })
      return resolve
    },
  }
}

test('boot loads plugin state before the plugin center is opened', async () => {
  const controlled = controlledClient(snapshot(5))
  const { store, dispose } = createIrisStore(controlled.client, source)

  await store.getState().boot()

  assert.equal(controlled.pluginLists(), 1)
  assert.equal(store.getState().systemPlugins?.revision, 5)
  dispose()
})

test('pushes and mutation responses cannot roll plugin state backward', async () => {
  const controlled = controlledClient(snapshot(5))
  const { store, dispose } = createIrisStore(controlled.client, source)
  await store.getState().boot()

  controlled.push({ type: 'plugins.changed', snapshot: snapshot(4, 'disabled') })
  assert.equal(store.getState().systemPlugins?.revision, 5)

  await store.getState().enableSystemPlugin('tavern-helper')
  assert.equal(store.getState().systemPlugins?.revision, 8)
  assert.equal(store.getState().systemPlugins?.plugins[0]?.status, 'enabled')
  dispose()
})

test('reconnect list replaces an old host snapshot even with a lower revision', async () => {
  const controlled = controlledClient(snapshot(12))
  const { store, dispose } = createIrisStore(controlled.client, source)
  await store.getState().boot()
  controlled.setListed(snapshot(2, 'disabled'))

  controlled.reconnect()
  await new Promise(resolve => setTimeout(resolve, 0))

  assert.equal(controlled.pluginLists(), 2)
  assert.equal(store.getState().systemPlugins?.revision, 2)
  assert.equal(store.getState().systemPlugins?.plugins[0]?.status, 'disabled')
  dispose()
})

test('a list response cannot erase a newer event from the same host session', async () => {
  const controlled = controlledClient(snapshot(5))
  const { store, dispose } = createIrisStore(controlled.client, source)
  await store.getState().boot()
  const finishList = controlled.deferNextList()

  const refreshing = store.getState().refreshSystemPlugins()
  controlled.push({ type: 'plugins.changed', snapshot: snapshot(7, 'disabled') })
  finishList(snapshot(6, 'enabling'))
  await refreshing

  assert.equal(store.getState().systemPlugins?.revision, 7)
  assert.equal(store.getState().systemPlugins?.plugins[0]?.status, 'disabled')
  dispose()
})

test('a new-session event wins over an older list that was already in flight', async () => {
  const controlled = controlledClient(snapshot(12))
  const { store, dispose } = createIrisStore(controlled.client, source)
  await store.getState().boot()
  const finishList = controlled.deferNextList()

  controlled.reconnect()
  controlled.push({ type: 'plugins.changed', snapshot: snapshot(3, 'disabled') })
  finishList(snapshot(2, 'enabling'))
  await new Promise(resolve => setTimeout(resolve, 0))

  assert.equal(store.getState().systemPlugins?.revision, 3)
  assert.equal(store.getState().systemPlugins?.plugins[0]?.status, 'disabled')
  dispose()
})

test('a mutation response from the previous process cannot enter the reconnected session', async () => {
  const controlled = controlledClient(snapshot(12))
  const { store, dispose } = createIrisStore(controlled.client, source)
  await store.getState().boot()
  const finishEnable = controlled.deferNextEnable()
  const enabling = store.getState().enableSystemPlugin('tavern-helper')
  controlled.setListed(snapshot(2, 'disabled'))

  controlled.reconnect()
  await new Promise(resolve => setTimeout(resolve, 0))
  finishEnable(snapshot(13, 'enabled'))
  await enabling

  assert.equal(store.getState().systemPlugins?.revision, 2)
  assert.equal(store.getState().systemPlugins?.plugins[0]?.status, 'disabled')
  dispose()
})
