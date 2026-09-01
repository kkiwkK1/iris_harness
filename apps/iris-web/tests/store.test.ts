import assert from 'node:assert/strict'
import { test } from 'node:test'

import { actionsOf, applyEvent, createIrisStore, type IrisStore } from '../src/client/store.ts'
import type { ChatView, IrisClient, IrisEvent } from '@iris/protocol'
import { createFakeClient } from '@iris/client-fake'

import { consentState } from '../src/sandbox/consent.ts'

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
  const { store, dispose } = createIrisStore(stub.client, TEST_SOURCE)
  store.setState({ chatId: 'c1', view: { chatId: 'c1', title: 'A scene', messages: [] } })
  return { store, push: stub.push, setConnected: stub.setConnected, dispose }
}

/** Stated rather than defaulted, so a test never silently claims a transport. */
const TEST_SOURCE = { transport: 'fake' as const, origin: 'test' }

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
  const { store, dispose } = createIrisStore(stub.client, TEST_SOURCE)
  dispose()

  stub.setConnected(false)

  assert.equal(store.getState().connected, true)
})

test('disposing the store drops its event subscription', () => {
  const stub = stubClient()
  const { store, dispose } = createIrisStore(stub.client, TEST_SOURCE)
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
  const { store, dispose } = createIrisStore(client, TEST_SOURCE)

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
  const { store, dispose } = createIrisStore(client, TEST_SOURCE)

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
  const { store, dispose } = createIrisStore(client, TEST_SOURCE)

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
  const { store, dispose } = createIrisStore(client, TEST_SOURCE)

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
  const { store, dispose } = createIrisStore(client, TEST_SOURCE)

  const result = await store.getState().scriptBody('char-1', 'var_update')

  assert.ok(result.ok)
  assert.equal(result.content, 'console.log(1)')
  dispose()
})

test('the action set keeps one identity across writes', () => {
  /*
   * The bug this pins wedged a browser renderer.
   *
   * `getState()` returns a new object after every write. Anything using it as a
   * `useEffect` dependency therefore re-fires on every store change, and an
   * effect that calls an action becomes a loop with no exit: action writes,
   * identity changes, effect re-runs, action writes. The page never finishes
   * loading and the console stays empty, because nothing has thrown.
   *
   * It sat latent for days in the boot effect without firing, only because that
   * component selects primitives that happen not to change. Depending on what a
   * neighbouring selector returns is not a property worth having.
   */
  const stub = stubClient()
  const { store, dispose } = createIrisStore(stub.client, TEST_SOURCE)

  const before = actionsOf(store)
  store.setState({ booting: false })
  store.setState({ chats: [{ chatId: 'x', title: 'x', updatedAt: 1, messageCount: 0 }] })

  assert.equal(actionsOf(store), before, 'an effect keyed on the actions would re-fire')
  // And the raw state object does change, which is why the facade has to exist.
  assert.notEqual(store.getState(), before)
  dispose()
})

test('the facade carries every action and nothing else', () => {
  // Picked by type rather than listed: a hand-written list would be a second
  // declaration of the action set and would drift the first time one is added.
  const stub = stubClient()
  const { store, dispose } = createIrisStore(stub.client, TEST_SOURCE)
  const facade = actionsOf(store) as unknown as Record<string, unknown>
  const state = store.getState() as unknown as Record<string, unknown>

  const functionKeys = Object.entries(state)
    .filter(([, value]) => typeof value === 'function')
    .map(([key]) => key)
    .sort()

  assert.deepEqual(Object.keys(facade).sort(), functionKeys)
  assert.ok(functionKeys.includes('boot') && functionKeys.includes('loadConnections'))
  // No state leaked in: a facade carrying `chats` would go stale silently.
  assert.equal('chats' in facade, false)
  dispose()
})

test('two stores get their own facades', () => {
  const a = createIrisStore(stubClient().client, TEST_SOURCE)
  const b = createIrisStore(stubClient().client, TEST_SOURCE)
  assert.notEqual(actionsOf(a.store), actionsOf(b.store))
  a.dispose()
  b.dispose()
})

test('a card action not on the allowlist is refused by the shell, by name', () => {
  // The frame shapes its facade from the same list, but that is convenience. The
  // frame is the untrusted side: a card reaching the shell with a name the shell
  // does not know is refused here regardless of what the frame believed it was
  // offering.
  const stub = stubClient()
  const { store, dispose } = createIrisStore(stub.client, TEST_SOURCE)
  store.setState({ chatId: 'c1' })

  return store
    .getState()
    .runCardAction('deleteAllChats', {})
    .then(
      () => assert.fail('an unlisted action should not reach the wire'),
      (error: unknown) => {
        // Names the action, and does not claim to know *why* it is absent.
        // "Iris does not let card scripts call X" read as a settled decision,
        // and the usual reason a name is missing from that table is that nobody
        // has built it yet — which is a request, not a refusal.
        assert.match(String(error), /deleteAllChats is not one of the actions/)
        assert.doesNotMatch(String(error), /does not let/)
        dispose()
      },
    )
})

test('an allowed card action reaches its wire method with the chat attached', async () => {
  const seen: { method: string, params: unknown }[] = []
  const stub = stubClient()
  const client: IrisClient = {
    ...stub.client,
    call: async (method, params) => {
      seen.push({ method, params })
      return {} as never
    },
  }
  const { store, dispose } = createIrisStore(client, TEST_SOURCE)
  store.setState({ chatId: 'c1' })

  await store.getState().runCardAction('saveMetadata', { metadata: { a: 1 } })

  assert.deepEqual(seen, [{ method: 'script.saveMetadata', params: { chatId: 'c1', metadata: { a: 1 } } }])
  dispose()
})

test('a deleted card does not bequeath its document grant to the next card of that name', async () => {
  /*
   * The host mints character ids with `uniqueId(toId(name), existing)` against
   * the cards that currently exist, so deleting "Aria" frees `aria` and the next
   * card called Aria is handed the same id. `loadScripts` returns early when its
   * cache already names that id — so the new card would be shown the deleted
   * one's scripts, and its `documentGranted`.
   *
   * That is a grant the user gave to a different card. The host forgets it on
   * delete; this test is the other half, because a cache that answers without
   * asking would hand it straight back.
   */
  // The host's view: one card, then a different card that reuses its id.
  let grantedByHost = true
  let scriptOnDisk = 'old-card-script'
  const client: IrisClient = {
    connected: true,
    onConnectionChange: () => () => undefined,
    subscribe: () => () => undefined,
    async call(method) {
      if (method === 'script.list') {
        return {
          scripts: [{ id: scriptOnDisk, name: scriptOnDisk }],
          documentGranted: grantedByHost,
        } as never
      }
      if (method === 'character.delete') {
        // What the host's `forget` does: the freed id carries no grant. The next
        // card to claim `aria` is a different card, with its own script.
        grantedByHost = false
        scriptOnDisk = 'new-card-script'
        return {} as never
      }
      if (method === 'character.list') return { characters: [] } as never
      if (method === 'chat.list') return { chats: [] } as never
      if (method === 'settings.get') return { settings: { provider: 'p', model: 'm' } } as never
      return {} as never
    },
  }

  const { store, dispose } = createIrisStore(client, TEST_SOURCE)
  const actions = actionsOf(store)

  await actions.loadScripts('aria')
  assert.equal(store.getState().documentGranted, true, 'the first card really was granted')

  await actions.deleteCharacter('aria')
  await actions.loadScripts('aria')

  assert.equal(
    store.getState().documentGranted,
    false,
    'a new card inherited a grant the user never gave it',
  )
  assert.deepEqual(
    store.getState().scripts.map(row => row.id),
    ['new-card-script'],
    'the panel must show this card, not the one that used to hold the id',
  )
  dispose()
})

test('the browser half of delete → reimport → open: nothing is inherited', async () => {
  /*
   * The browser side of the cross-trust-domain check. The host owns the other
   * half; this one asserts that the shell asks again and believes the answer.
   *
   * It runs against the real fake rather than a bespoke stub, which is the point:
   * the fake mints ids the way the host does, so deleting a card frees its id and
   * the next card of that name receives it. A client that could not express that
   * could not host this test, and an interface built against one would never show
   * the defect.
   *
   * The load-bearing assertion is `unasked` rather than `declined`. Inheriting a
   * decline is the worst of the three outcomes: the new card's scripts are never
   * offered and never run, and nothing anywhere reports why.
   */
  const client = createFakeClient()
  const { store, dispose } = createIrisStore(client, TEST_SOURCE)
  const actions = actionsOf(store)

  const first = await client.call('character.import', {
    filename: 'Aria.png',
    // Not a real card: `readCard` falls back to the filename for the name, which
    // is all this test needs and keeps a PNG fixture out of it.
    content: 'AAAA',
  })
  const id = first.character.characterId

  await client.call('script.setDocumentGrant', { characterId: id, granted: true })
  await client.call('script.setScriptsAllowed', { characterId: id, allowed: true })
  await actions.loadScripts(id)
  assert.equal(store.getState().documentGranted, true, 'the first card really was granted')

  await actions.deleteCharacter(id)
  const second = await client.call('character.import', {
    filename: 'Aria.png',
    // Not a real card: `readCard` falls back to the filename for the name, which
    // is all this test needs and keeps a PNG fixture out of it.
    content: 'AAAA',
  })
  assert.equal(second.character.characterId, id, 'the freed id is handed to the next card')

  const listed = await client.call('script.list', { characterId: id })
  assert.equal(
    consentState(listed),
    'unasked',
    'a new card inherited an answer given about another card',
  )
  assert.equal(listed.documentGranted, false, 'and it inherited page access too')

  await actions.loadScripts(id)
  assert.equal(store.getState().documentGranted, false, 'the shell cache answered for the dead card')
  dispose()
})

test('consent is read through the gate, so an unanswered card is not a declined one', async () => {
  /*
   * The store is where `?? false` would most naturally be written, because the
   * field beside it — `documentGranted` — is read exactly that way. Getting it
   * wrong here disables the whole feature with no error: the question is never
   * put, so nothing ever runs, so it looks like a card with no scripts.
   */
  const client = createFakeClient()
  const { store, dispose } = createIrisStore(client, TEST_SOURCE)
  const actions = actionsOf(store)
  const { character } = await client.call('character.import', {
    filename: 'Nadia.png',
    content: 'AAAA',
  })

  await actions.loadScripts(character.characterId)
  assert.equal(store.getState().scriptsAllowed, 'unasked', 'nobody has been asked yet')

  await actions.answerScriptsAllowed(false)
  assert.equal(store.getState().scriptsAllowed, 'declined')

  // Re-read from the host: a decline must survive, or the question returns on
  // every chat the user opens.
  await actions.loadScripts('other')
  await actions.loadScripts(character.characterId)
  assert.equal(store.getState().scriptsAllowed, 'declined', 'the decline was not stored')

  await actions.answerScriptsAllowed(true)
  assert.equal(store.getState().scriptsAllowed, 'allowed')
  dispose()
})

test('switching cards does not carry the previous answer across', async () => {
  // A consent state left standing while the card underneath changes is the same
  // fault as a grant that outlives its subject — the panel would offer to run
  // one card's scripts on the strength of an answer given about another.
  const client = createFakeClient()
  const { store, dispose } = createIrisStore(client, TEST_SOURCE)
  const actions = actionsOf(store)
  const first = await client.call('character.import', { filename: 'One.png', content: 'AAAA' })
  const second = await client.call('character.import', { filename: 'Two.png', content: 'AAAA' })

  await actions.loadScripts(first.character.characterId)
  await actions.answerScriptsAllowed(true)
  assert.equal(store.getState().scriptsAllowed, 'allowed')

  await actions.loadScripts(second.character.characterId)

  assert.equal(store.getState().scriptsAllowed, 'unasked', 'the second card was never asked')
  assert.deepEqual(store.getState().runStates, [], "and it is not showing the first card's runs")
  dispose()
})

test('a fault of Iris does not read as the host answering', async () => {
  /*
   * `guard`'s job is described as turning a host refusal into a notice. It also
   * catches bugs in the guarded callback, which arrive as a plain Error, get
   * relabelled `internal` — a code the host genuinely uses — and then reach the
   * user in the same sentence a host refusal would. Same notice, opposite
   * origin, reader sent to the wrong side.
   *
   * The two are distinguishable at the moment they are caught, and that
   * distinction was being discarded one line later.
   */
  const client: IrisClient = {
    connected: true,
    onConnectionChange: () => () => undefined,
    subscribe: () => () => undefined,
    async call(method) {
      if (method === 'script.list') {
        // Not a host error: no code, the shape a bug in our own code has.
        throw new TypeError('cannot read properties of undefined')
      }
      if (method === 'chat.list') return { chats: [] } as never
      if (method === 'character.list') return { characters: [] } as never
      if (method === 'settings.get') return { settings: { provider: 'p', model: 'm' } } as never
      return {} as never
    },
  }
  const { store, dispose } = createIrisStore(client, TEST_SOURCE)

  await actionsOf(store).loadScripts('someone')

  assert.match(store.getState().notice?.text ?? '', /Iris hit a problem of its own/)
  dispose()
})

test('frame-level reports survive where the notice bar destroys them', async () => {
  /*
   * The notice bar is one slot that clears itself after eight seconds. A burst of
   * startup reports therefore overwrites itself and the survivor evaporates — and
   * a verification round concluded the warnings were never emitted when in fact
   * every one had arrived and been destroyed by the channel carrying it.
   *
   * So the card keeps its own list: durable until the card changes, deduplicated
   * so a polled slot cannot flood it.
   */
  const client = createFakeClient()
  const { store, dispose } = createIrisStore(client, TEST_SOURCE)
  const actions = actionsOf(store)

  actions.addCardReport('a card read parent.toastr, which nothing has published')
  actions.addCardReport('an unhandled rejection after the card body finished: Error: boom')
  actions.addCardReport('a card read parent.toastr, which nothing has published')

  assert.equal(store.getState().cardReports.length, 2, 'the same fact is recorded once')
  assert.match(store.getState().cardReports.join(' '), /unhandled rejection/)

  // The notice, by contrast, only ever holds the last one.
  assert.equal(store.getState().notice, undefined, 'reports do not implicitly notify')
  dispose()
})

test('a card switch clears the previous card reports', async () => {
  // They belong to the card that produced them. Carrying them across would
  // attribute one card's frame problems to the next one opened.
  const client = createFakeClient()
  const { store, dispose } = createIrisStore(client, TEST_SOURCE)
  const actions = actionsOf(store)
  const one = await client.call('character.import', { filename: 'One.png', content: 'AAAA' })
  const two = await client.call('character.import', { filename: 'Two.png', content: 'AAAA' })

  await actions.loadScripts(one.character.characterId)
  actions.addCardReport('something about the first card')
  await actions.loadScripts(two.character.characterId)

  assert.deepEqual(store.getState().cardReports, [])
  dispose()
})
