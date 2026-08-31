import assert from 'node:assert/strict'
import { test } from 'node:test'

import { applyEvent, createIrisStore, type IrisStore } from '../src/client/store.ts'
import type { ChatView, IrisClient, IrisEvent } from '@iris/protocol'

/** A client that records calls and lets a test push frames by hand. */
function stubClient(): {
  client: IrisClient
  push: (event: IrisEvent) => void
  setConnected: (connected: boolean) => void
} {
  const listeners = new Set<(event: IrisEvent) => void>()
  const connectionListeners = new Set<(connected: boolean) => void>()
  const client: IrisClient = {
    connected: true,
    // Drivable rather than inert: the store's only route to the connection state
    // is now this channel, so a stub that never fires would leave the offline
    // banner untested.
    onConnectionChange(listener) {
      connectionListeners.add(listener)
      return () => {
        connectionListeners.delete(listener)
      }
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    async call(method) {
      const empty: ChatView = { chatId: 'c1', title: 'A scene', messages: [] }
      if (method === 'chat.list') return { chats: [] } as never
      if (method === 'character.list') return { characters: [] } as never
      if (method === 'settings.get') return { settings: { provider: 'p', model: 'm' } } as never
      return { view: empty } as never
    },
  }
  return {
    client,
    push: event => listeners.forEach(listener => listener(event)),
    setConnected: connected => connectionListeners.forEach(listener => listener(connected)),
  }
}

/** A store with a chat already open, so chat-scoped frames are not filtered out. */
function openedStore(): {
  store: IrisStore
  push: (event: IrisEvent) => void
  setConnected: (connected: boolean) => void
  dispose: () => void
} {
  const stub = stubClient()
  const { store, dispose } = createIrisStore(stub.client)
  store.setState({ chatId: 'c1', view: { chatId: 'c1', title: 'A scene', messages: [] } })
  return { store, push: stub.push, setConnected: stub.setConnected, dispose }
}

const settled: ChatView = {
  chatId: 'c1',
  title: 'A scene',
  messages: [{ id: 0, key: 'a0', role: 'assistant', name: 'A', text: 'the whole reply', turn: 0 }],
}

test('deltas accumulate into the stream buffer', () => {
  const { store, push, dispose } = openedStore()

  push({ type: 'stream.start', chatId: 'c1', turn: 0, key: 'k0' })
  push({ type: 'stream.text', chatId: 'c1', turn: 0, delta: 'the ' })
  push({ type: 'stream.text', chatId: 'c1', turn: 0, delta: 'whole' })
  push({ type: 'stream.reasoning', chatId: 'c1', turn: 0, delta: 'hm' })

  assert.deepEqual(store.getState().stream, { turn: 0, text: 'the whole', reasoning: 'hm', key: 'k0' })
  dispose()
})

test('stream.end replaces the view and drops the buffer', () => {
  const { store, push, dispose } = openedStore()

  push({ type: 'stream.start', chatId: 'c1', turn: 0, key: 'k0' })
  push({ type: 'stream.text', chatId: 'c1', turn: 0, delta: 'partial' })
  push({ type: 'stream.end', chatId: 'c1', turn: 0, view: settled })

  // The whole point of the contract: no reconciliation, one swap.
  assert.equal(store.getState().stream, undefined)
  assert.equal(store.getState().view, settled)
  dispose()
})

test('a delta for a turn whose opening was missed still starts a buffer', () => {
  // A reconnect mid-generation looks exactly like this, and discarding the
  // deltas would leave the reader watching a message that never fills in.
  const { store, push, dispose } = openedStore()

  push({ type: 'stream.text', chatId: 'c1', turn: 4, delta: 'mid-sentence' })

  assert.deepEqual(store.getState().stream, { turn: 4, text: 'mid-sentence', reasoning: '' })
  dispose()
})

test('a delta for a different turn restarts the buffer rather than appending', () => {
  const { store, push, dispose } = openedStore()

  push({ type: 'stream.start', chatId: 'c1', turn: 0, key: 'k0' })
  push({ type: 'stream.text', chatId: 'c1', turn: 0, delta: 'old' })
  push({ type: 'stream.text', chatId: 'c1', turn: 1, delta: 'new' })

  assert.deepEqual(store.getState().stream, { turn: 1, text: 'new', reasoning: '' })
  dispose()
})

test('frames for a chat this page is not showing are ignored', () => {
  const { store, push, dispose } = openedStore()

  push({ type: 'stream.start', chatId: 'other', turn: 0, key: 'k0' })
  push({ type: 'stream.text', chatId: 'other', turn: 0, delta: 'not ours' })

  assert.equal(store.getState().stream, undefined)
  dispose()
})

test('chat.updated does not blank text arriving for a later turn', () => {
  // An edit or a swipe landing mid-generation must not clear the buffer, or the
  // reply being written vanishes from under the reader.
  const { store, push, dispose } = openedStore()

  push({ type: 'stream.start', chatId: 'c1', turn: 2, key: 'k2' })
  push({ type: 'stream.text', chatId: 'c1', turn: 2, delta: 'arriving' })
  push({ type: 'chat.updated', chatId: 'c1', view: settled })

  assert.equal(store.getState().view, settled)
  assert.deepEqual(store.getState().stream, { turn: 2, text: 'arriving', reasoning: '', key: 'k2' })
  dispose()
})

test('stream.error clears the buffer and raises a notice', () => {
  const { store, push, dispose } = openedStore()

  push({ type: 'stream.start', chatId: 'c1', turn: 0, key: 'k0' })
  push({ type: 'stream.text', chatId: 'c1', turn: 0, delta: 'half' })
  push({
    type: 'stream.error',
    chatId: 'c1',
    turn: 0,
    code: 'provider-error',
    message: 'the model closed the connection',
  })

  assert.equal(store.getState().stream, undefined)
  assert.equal(store.getState().notice?.kind, 'error')
  assert.equal(store.getState().notice?.text, 'the model closed the connection')
  dispose()
})

test('chats.updated is not filtered by the open chat', () => {
  const { store, push, dispose } = openedStore()

  push({
    type: 'chats.updated',
    chats: [{ chatId: 'zzz', title: 'Elsewhere', updatedAt: 1, messageCount: 2 }],
  })

  assert.equal(store.getState().chats.length, 1)
  dispose()
})

test('the connection state arrives on its own channel, not inferred from traffic', () => {
  const { store, setConnected, dispose } = openedStore()

  setConnected(false)
  assert.equal(store.getState().connected, false)

  // The point of the dedicated channel: the banner must not have to wait for
  // unrelated traffic to notice, and unrelated traffic must not clear it.
  applyEvent(store, { type: 'chats.updated', chats: [] })
  assert.equal(store.getState().connected, false)

  setConnected(true)
  assert.equal(store.getState().connected, true)
  dispose()
})

test('disposing the store also drops its connection subscription', () => {
  const stub = stubClient()
  const { store, dispose } = createIrisStore(stub.client)
  dispose()

  stub.setConnected(false)

  assert.equal(store.getState().connected, true)
})

test('disposing the store drops its event subscription', () => {
  const stub = stubClient()
  const { store, dispose } = createIrisStore(stub.client)
  store.setState({ chatId: 'c1' })
  dispose()

  stub.push({ type: 'stream.start', chatId: 'c1', turn: 0, key: 'k0' })

  // A plugin that leaves a listener behind is the failure Iris's reversible
  // mounting exists to prevent, so it is worth a test rather than a comment.
  assert.equal(store.getState().stream, undefined)
})

test('boot opens the most recent conversation', async () => {
  const stub = stubClient()
  const listed = { chats: [{ chatId: 'c9', title: 'Latest', updatedAt: 9, messageCount: 1 }] }
  const client: IrisClient = {
    ...stub.client,
    async call(method) {
      if (method === 'chat.list') return listed as never
      if (method === 'character.list') return { characters: [] } as never
      if (method === 'settings.get') return { settings: { provider: 'p', model: 'm' } } as never
      if (method === 'chat.open') return { view: { chatId: 'c9', title: 'Latest', messages: [] } } as never
      throw new Error(`unexpected ${method}`)
    },
  }
  const { store, dispose } = createIrisStore(client)

  await store.getState().boot()

  assert.equal(store.getState().chatId, 'c9')
  assert.equal(store.getState().booting, false)
  dispose()
})

test('a refused call becomes a notice instead of an unhandled rejection', async () => {
  const stub = stubClient()
  const client: IrisClient = {
    ...stub.client,
    call: async () => {
      throw Object.assign(new Error('no chat "gone"'), { code: 'not-found' })
    },
  }
  const { store, dispose } = createIrisStore(client)

  await store.getState().openChat('gone')

  assert.equal(store.getState().notice?.kind, 'error')
  assert.match(store.getState().notice?.text ?? '', /not there any more/)
  dispose()
})

/** A client whose `script.body` fails the way a host would. */
function refusingClient(error: { code: string, message: string }): IrisClient {
  const stub = stubClient()
  return {
    ...stub.client,
    call: async method => {
      if (method === 'script.body') throw Object.assign(new Error(error.message), { code: error.code })
      throw new Error(`unexpected ${method}`)
    },
  }
}

test('a refused script body reports the host that refused it, not a guess', () => {
  // The bug this pins: the caller printed "the fake client refuses bodies"
  // whatever the cause, and then showed it for a refusal from a real host — which
  // sent someone to debug a transport that was already working. An explanation
  // that does not depend on the failure is a guess in a confident voice.
  const client = refusingClient({ code: 'unsupported', message: 'the script provider is not wired' })
  const { store, dispose } = createIrisStore(client)

  return store
    .getState()
    .scriptBody('char-1', 'var_update')
    .then(result => {
      assert.equal(result.ok, false)
      assert.ok(!result.ok)
      assert.equal(result.error.code, 'unsupported')
      assert.match(result.error.message, /not wired/)
      dispose()
    })
})

test('a refusal of any code arrives intact, not normalised to one story', () => {
  const client = refusingClient({ code: 'not-found', message: 'no script "gone"' })
  const { store, dispose } = createIrisStore(client)

  return store
    .getState()
    .scriptBody('char-1', 'gone')
    .then(result => {
      assert.ok(!result.ok)
      assert.equal(result.error.code, 'not-found')
      dispose()
    })
})

test('a body that arrives is handed back whole', async () => {
  const stub = stubClient()
  const client: IrisClient = {
    ...stub.client,
    call: async method => {
      if (method === 'script.body') return { content: 'console.log(1)' } as never
      throw new Error(`unexpected ${method}`)
    },
  }
  const { store, dispose } = createIrisStore(client)

  const result = await store.getState().scriptBody('char-1', 'var_update')

  assert.ok(result.ok)
  assert.equal(result.content, 'console.log(1)')
  dispose()
})
