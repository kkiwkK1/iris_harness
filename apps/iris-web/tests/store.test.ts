import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  actionsOf,
  applyEvent,
  createIrisStore,
  noticeRecurrenceKey,
  NOTICE_DEDUP_WINDOW_MS,
  NOTICE_LOG_LIMIT,
  repeatsLatestNotice,
  type IrisStore,
  type Notice,
} from '../src/client/store.ts'
import type { ChatView, IrisClient, IrisEvent } from '@iris/protocol'
import { createFakeClient } from '@iris/client-fake'

import { consentState, interfacesMayBuild } from '../src/sandbox/consent.ts'

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

/** The reports as one string, for assertions that do not care about generations. */
function reportText(reports: readonly { text: string }[]): string {
  return reports.map(report => report.text).join(' ')
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
  push({ type: 'stream.end', chatId: 'c1', turn: 0, view: settled, reason: 'completed' })

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

test('a refusal for having no provider is worded here, not passed through', () => {
  /*
   * The one `stream.error` code whose sentence is written in the browser
   * (host §61, web §79). The host's own detail is about routes — it says this
   * host no longer generates through the one it was launched with — and what
   * the reader needs is the next step: which card to open, which verb to press,
   * in their own language. So the code selects the copy and the detail is
   * dropped, which is the opposite of the rule for every other failure above.
   */
  const { store, push, dispose } = openedStore()

  push({ type: 'stream.start', chatId: 'c1', turn: 0, key: 'k0' })
  push({
    type: 'stream.error',
    chatId: 'c1',
    turn: 0,
    code: 'no-provider',
    message: 'no connection provider is in use, so there is nothing to generate through',
  })

  assert.equal(store.getState().stream, undefined, 'the buffer survived a refusal')
  assert.equal(store.getState().notice?.kind, 'error')
  const text = store.getState().notice?.text ?? ''
  // The dictionary's sentence, and the two things it has to carry: that nothing
  // is in use, and where to go. Matched on the copy rather than on the key so a
  // sentence that stopped pointing anywhere goes red.
  assert.match(text, /No provider is in use/, 'the reader was not told what is missing')
  assert.match(text, /Settings → Connection/, 'the reader was not told where to fix it')
  assert.doesNotMatch(text, /generate through$/, 'the host’s own route sentence was passed through instead')
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
        assert.match(String(error), /deleteAllChats was not forwarded/)
        assert.doesNotMatch(String(error), /does not let/)
        /*
         * And says whose refusal it is. `writeButtons` wraps a rejection from
         * this line for the reader, so a message that did not name this app was
         * read as the host's answer to a request the host never received — two
         * sessions checked the host's handler, registration and contract across
         * three commits before either checked this list for a missing line.
         */
        assert.match(String(error), /this app does not list it/)
        assert.match(String(error), /the host was never asked/)
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

test('a script-less card sits at unasked, and the interface gate admits exactly that', async () => {
  /*
   * The dead state this pins, measured live on 人偶演出Lights ON: a card whose
   * only surface is a message interface and which carries **no** scripts.
   * `ConsentAsk` suppresses the question for an empty list ("a card with no
   * scripts is not a decision"), and the host — honestly — reports
   * `scriptsAllowed` as absent, which reads straight as `unasked`. The fault
   * this once caused was real: the interface pipeline gated on the same field,
   * so the card sat at `unasked` forever and its greeting rendered no frame.
   *
   * Two fixes were proposed. The one that landed is at the **gate**:
   * `interfacesMayBuild` admits `unasked` when the script count is zero, so
   * the store keeps saying only what the host said, and `unasked` stays the
   * truth about what was asked. This test pins both halves — the store's
   * honest state, and the gate's admission — because either alone is the bug
   * back again: a store that derives `allowed` lies about consent, and a gate
   * that drops the zero-script branch blanks the card again.
   *
   * The stub returns the host's exact unanswered shape: no `scriptsAllowed` key
   * at all, not `false`.
   */
  const client: IrisClient = {
    connected: true,
    onConnectionChange: () => () => undefined,
    subscribe: () => () => undefined,
    async call(method) {
      if (method === 'script.list') {
        return { scripts: [], documentGranted: false } as never
      }
      if (method === 'character.list') return { characters: [] } as never
      if (method === 'chat.list') return { chats: [] } as never
      if (method === 'settings.get') return { settings: { provider: 'p', model: 'm' } } as never
      return {} as never
    },
  }

  const { store, dispose } = createIrisStore(client, TEST_SOURCE)
  const actions = actionsOf(store)

  await actions.loadScripts('scriptless')
  assert.equal(
    store.getState().scriptsAllowed,
    'unasked',
    'the store says only what the host said: nobody has asked a script-less card',
  )
  assert.equal(store.getState().scripts.length, 0)
  assert.ok(
    interfacesMayBuild(store.getState().scriptsAllowed, store.getState().scripts.length),
    'the gate admits the script-less unasked card, or its interface never renders',
  )

  // Not written back: the next card re-derives from its own list, so a stub
  // that starts answering (a card with scripts, still unanswered) is read as
  // `unasked` — the question goes out, exactly as the gate test below pins.
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
  assert.match(reportText(store.getState().cardReports), /unhandled rejection/)

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

test('a report from an earlier run keeps its generation, so it cannot read as current', () => {
  /*
   * The failure this prevents was read off a live panel: "the provider import
   * timed out" sat beside an error that could only have come from a run where
   * that same import had *succeeded*. Both were true when written, both were
   * phrased in the present tense, and telling them apart required a person who
   * remembered the order of the afternoon.
   */
  const client = createFakeClient()
  const { store, dispose } = createIrisStore(client, TEST_SOURCE)
  const actions = actionsOf(store)

  actions.beginCardRun()
  actions.addCardReport('the provider import timed out')
  const first = store.getState().cardRunGeneration

  actions.beginCardRun()
  actions.addCardReport('getTavernHelperVersion is not defined')
  const second = store.getState().cardRunGeneration

  assert.notEqual(first, second, 'two runs must never share a generation')
  const reports = store.getState().cardReports
  assert.equal(reports.length, 2)
  assert.equal(reports[0]?.generation, first, 'the older finding is still dated to its own run')
  assert.equal(reports[1]?.generation, second)
  dispose()
})

test('a fact that recurs in a new run is re-dated rather than left stale or duplicated', () => {
  /*
   * Both halves matter. Suppressing it as a duplicate would leave the panel
   * showing a live problem stamped with a run that ended long ago; appending it
   * again would turn a card that polls into a scrolling wall of one sentence.
   */
  const client = createFakeClient()
  const { store, dispose } = createIrisStore(client, TEST_SOURCE)
  const actions = actionsOf(store)

  actions.beginCardRun()
  actions.addCardReport('the provider import timed out')

  actions.beginCardRun()
  actions.addCardReport('the provider import timed out')

  const reports = store.getState().cardReports
  assert.equal(reports.length, 1, 'the same fact stays one entry')
  assert.equal(
    reports[0]?.generation,
    store.getState().cardRunGeneration,
    'a problem that is still happening must not be shown as history',
  )
  dispose()
})

test('a repeat within one run does not re-date anything', () => {
  // A card polling a missing slot must not keep the panel churning.
  const client = createFakeClient()
  const { store, dispose } = createIrisStore(client, TEST_SOURCE)
  const actions = actionsOf(store)

  actions.beginCardRun()
  actions.addCardReport('same fact')
  const before = store.getState().cardReports
  actions.addCardReport('same fact')

  assert.deepEqual(store.getState().cardReports, before)
  dispose()
})

test('a report is withdrawn when the script it condemned turns out to have worked', () => {
  /*
   * Observed on a real card. The provider's bundle arrived a few seconds past
   * the fifteen-second deadline, ran, published, and woke all three consumers —
   * and the panel went on saying it had failed. A verdict that later evidence
   * refutes is worse than no verdict: it tells someone a working card is broken.
   */
  const client = createFakeClient()
  const { store, dispose } = createIrisStore(client, TEST_SOURCE)
  const actions = actionsOf(store)

  actions.beginCardRun()
  actions.addCardReport('MVU: failed: import timed out after 15s', { scriptId: 'provider' })
  actions.addCardReport('another script: failed: something else', { scriptId: 'other' })

  actions.withdrawReportsFor('provider')

  const reports = store.getState().cardReports
  assert.equal(reports.length, 2, 'withdrawn is marked, not deleted')
  assert.equal(reports[0]?.withdrawn, true)
  assert.equal(
    reports[1]?.withdrawn,
    undefined,
    'withdrawing one script\u2019s verdict must not touch another\u2019s',
  )
  dispose()
})

test('withdrawal keeps the record, because the delay was real even though it resolved', () => {
  // Deleting would erase the only evidence that something took long enough to
  // be declared dead, and that delay is a genuine defect even when it resolves.
  const client = createFakeClient()
  const { store, dispose } = createIrisStore(client, TEST_SOURCE)
  const actions = actionsOf(store)

  actions.beginCardRun()
  actions.addCardReport('MVU: failed: import timed out after 15s', { scriptId: 'provider' })
  actions.withdrawReportsFor('provider')

  assert.match(reportText(store.getState().cardReports), /timed out after 15s/)
  dispose()
})

test('withdrawing when there is nothing to withdraw changes nothing', () => {
  const client = createFakeClient()
  const { store, dispose } = createIrisStore(client, TEST_SOURCE)
  const actions = actionsOf(store)

  actions.beginCardRun()
  actions.addCardReport('a note', { scriptId: 'a' })
  const before = store.getState().cardReports
  actions.withdrawReportsFor('nobody')

  assert.equal(store.getState().cardReports, before, 'no needless re-render')
  dispose()
})
/** The offer as the host raises it. */
const OFFER = {
  type: 'cleanup.offer' as const,
  chatId: 'c1',
  lines: 812,
  from: 1,
  to: 780,
  layers: 6,
}

/** A store whose client records every call, for the answer round trip. */
function recordingStore(answer: {
  cleaned: number
  recorded: boolean
  backup?: string
} = { cleaned: 0, recorded: true }, failOn?: string): {
  store: IrisStore
  push: (event: IrisEvent) => void
  setConnected: (connected: boolean) => void
  calls: { method: string, params: unknown }[]
  dispose: () => void
} {
  const calls: { method: string, params: unknown }[] = []
  const listeners = new Set<(event: IrisEvent) => void>()
  const connectionListeners = new Set<(connected: boolean) => void>()
  const empty: ChatView = { chatId: 'c1', title: 'A scene', messages: [] }
  const client: IrisClient = {
    connected: true,
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
    async call(method, params) {
      calls.push({ method, params })
      // Drivable failure, so a test can exercise the notice an action's guard
      // raises rather than only the ones it calls `notify` for directly.
      if (method === failOn) throw new Error('the host refused')
      if (method === 'chat.list') return { chats: [] } as never
      if (method === 'character.list') return { characters: [] } as never
      if (method === 'settings.get') return { settings: { provider: 'p', model: 'm' } } as never
      // The real shape, so what the shell shows is driven by what the host
      // actually returns rather than by a placeholder.
      if (method === 'chat.answerCleanup') return answer as never
      return { view: empty } as never
    },
  }
  const { store, dispose } = createIrisStore(client, TEST_SOURCE)
  store.setState({ chatId: 'c1', view: empty })
  return {
    store,
    push: event => listeners.forEach(l => l(event)),
    setConnected: connected => connectionListeners.forEach(l => l(connected)),
    calls,
    dispose,
  }
}

test('a cleaning offer is held, with the chat it is about', () => {
  const scope = recordingStore()
  scope.push(OFFER)
  const held = scope.store.getState().cleanupOffer
  assert.deepEqual(held, { chatId: 'c1', lines: 812, from: 1, to: 780, layers: 6 })
  scope.dispose()
})

test('an offer that arrives before the chat is open is not dropped', () => {
  /*
   * **A race, not a preference.** The host raises the offer while a chat is
   * being opened, and this store's `chatId` is set by the `chat.open` reply. A
   * handler gated on the open chat would discard an offer that arrived a beat
   * early — which the protocol treats as a complete outcome (nothing cleaned,
   * nothing recorded, asked again next time) and a reader would experience as
   * "the dialog never appeared", with nothing anywhere saying why.
   */
  const scope = recordingStore()
  scope.store.setState({ chatId: undefined })
  scope.push(OFFER)
  assert.equal(scope.store.getState().cleanupOffer?.chatId, 'c1')
  scope.dispose()
})

test('answering sends the chat and the answer, and puts the offer away', async () => {
  const scope = recordingStore()
  scope.push(OFFER)
  await actionsOf(scope.store).answerCleanup('backup-and-clean')

  const call = scope.calls.find(it => it.method === 'chat.answerCleanup')
  assert.deepEqual(call?.params, { chatId: 'c1', answer: 'backup-and-clean' })
  assert.equal(scope.store.getState().cleanupOffer, undefined, 'the dialog stayed up')
  scope.dispose()
})

test('dismissing sends nothing at all, which is the divergence', async () => {
  /*
   * **The one deliberate difference from upstream, and the reason it needs a
   * test rather than a comment.** Upstream folds `CANCELLED` into `NEGATIVE`
   * (`legacy_chat.ts:27-33`), so one press of Esc writes `ignore_cleanup`
   * permanently: the user believes they deferred and the extension believes
   * they declined forever. Nothing on screen distinguishes the two.
   *
   * So the assertion is about **absence** — no call — which is exactly the
   * shape that a wrong implementation still passes if you only assert the
   * state. The count is checked too, because "the offer is gone" is true of
   * both the right behaviour and of silently sending `never`.
   */
  const scope = recordingStore()
  scope.push(OFFER)
  const before = scope.calls.length

  actionsOf(scope.store).dismissCleanupOffer()

  assert.equal(scope.store.getState().cleanupOffer, undefined)
  assert.equal(scope.calls.length, before, 'dismissing called the host')
  assert.equal(
    scope.calls.some(it => it.method === 'chat.answerCleanup'),
    false,
    'dismissing was reported as an answer',
  )
  scope.dispose()
})

test('answering with nothing offered is a no-op, not a call with no chat', async () => {
  // The dialog cannot be on screen without an offer, but the action is reachable
  // and a call carrying `chatId: undefined` would be refused by the schema —
  // which surfaces as an error notice about a question nobody asked.
  const scope = recordingStore()
  const before = scope.calls.length
  await actionsOf(scope.store).answerCleanup('clean')
  assert.equal(scope.calls.length, before)
  scope.dispose()
})
test('a backup path comes back to the reader, and a decline says nothing', async () => {
  /*
   * The one part of the outcome that has to reach the screen. A user who asked
   * for a backup *before* letting something be deleted needs to know where it
   * went — upstream toasts it for the same reason
   * (`runtime.cleanup.exportSucceeded`, `legacy_chat.ts:60-73`) — and an export
   * that succeeded silently is indistinguishable from one that was skipped.
   *
   * `never` says nothing: nothing was cleaned and nothing was backed up, so a
   * notice would be announcing an absence.
   */
  const scope = recordingStore({ cleaned: 12, recorded: true, backup: 'chats/backup-1.jsonl' })
  scope.push(OFFER)
  await actionsOf(scope.store).answerCleanup('backup-and-clean')
  const notice = scope.store.getState().notice
  assert.match(String(notice?.text), /cleaned 12 messages/)
  assert.match(String(notice?.text), /backup-1\.jsonl/)

  const declining = recordingStore({ cleaned: 0, recorded: true })
  declining.push(OFFER)
  await actionsOf(declining.store).answerCleanup('never')
  assert.equal(declining.store.getState().notice, undefined, 'declining announced something')
  scope.dispose()
  declining.dispose()
})

test('cleaning nothing is still reported, because zero answers the question', async () => {
  // The user pressed a button and is entitled to the outcome. Hiding a zero
  // leaves them unable to tell "there was nothing to clean" from "the button
  // did not work".
  const scope = recordingStore({ cleaned: 0, recorded: true })
  scope.push(OFFER)
  await actionsOf(scope.store).answerCleanup('clean')
  assert.match(String(scope.store.getState().notice?.text), /cleaned 0 messages/)
  scope.dispose()
})
test('every notice is kept after the bar has forgotten it', () => {
  /*
   * The bar shows one message for 3.2 seconds (8 for an error). That is right
   * for interrupting someone and useless for anyone who was not watching —
   * including every verification pass, two of which were spent scanning a DOM
   * for notices that had certainly fired and had already gone.
   */
  const scope = recordingStore()
  actionsOf(scope.store).notify('info', 'first thing')
  actionsOf(scope.store).notify('error', 'second thing')

  assert.deepEqual(
    scope.store.getState().noticeLog.map(it => `${it.kind}:${it.text}`),
    ['info:first thing', 'error:second thing'],
  )
  // Dated, so the log can be read against a clock rather than only in order.
  assert.ok((scope.store.getState().noticeLog[0]?.at ?? 0) > 0)
  scope.dispose()
})

test('a repeat inside the dedup window keeps one entry that carries the repeat count', async () => {
  /*
   * Rewritten when the window arrived. The old argument — "a repeat is two
   * events, and something recurred is usually the finding" — held for the
   * finding and failed for the reconnect schedule, which raises the *same*
   * sentence every few seconds during a host restart: one outage, four rows,
   * no more information per row than the first. The recurrence is still on
   * the record, as a count on the one entry; what the log no longer does is
   * spend a row per retry on it.
   */
  const scope = recordingStore()
  actionsOf(scope.store).notify('info', 'the same sentence')
  actionsOf(scope.store).notify('info', 'the same sentence')
  const log = scope.store.getState().noticeLog
  assert.equal(log.length, 1)
  assert.equal(log[0]?.count, 2)
  scope.dispose()
})

test('a notice raised by a failed action is logged too, not just ones from notify', async () => {
  /*
   * **The bypass that would have made this feature quietly incomplete.**
   * `notify` was not the only place a notice was built: the action guard's catch
   * and the card-import path each assembled their own `{ kind, text, seq }`. A
   * log added to `notify` alone would have missed exactly the notices most worth
   * keeping — the errors — and looked like it worked, because the ones a test
   * would naturally raise go through `notify`.
   *
   * So this drives a **failing action** rather than calling `notify`.
   */
  const scope = recordingStore({ cleaned: 0, recorded: true }, 'chat.rename')
  await actionsOf(scope.store).renameChat('c1', 'a new title')
  const logged = scope.store.getState().noticeLog
  assert.ok(logged.length > 0, 'a failed action raised a notice that was not logged')
  assert.equal(logged.at(-1)?.kind, 'error')
  scope.dispose()
})

test('the log is bounded, and says so once it is', () => {
  const scope = recordingStore()
  for (let i = 0; i < NOTICE_LOG_LIMIT + 5; i += 1) {
    actionsOf(scope.store).notify('info', `notice ${i}`)
  }
  const logged = scope.store.getState().noticeLog
  assert.equal(logged.length, NOTICE_LOG_LIMIT)
  // The oldest fell off the front, so the newest is the last one raised.
  assert.equal(logged.at(-1)?.text, `notice ${NOTICE_LOG_LIMIT + 4}`)
  assert.equal(logged[0]?.text, 'notice 5')
  /*
   * **The count, and it is off by one from the length.** At exactly the limit
   * nothing has been dropped yet — the next push drops the first — so a panel
   * keyed on `length >= LIMIT` announces a loss that has not happened. That was
   * the first version of the line, and a sentence that is false the moment it
   * first appears is worse than no sentence: it is the instrument talking about
   * itself.
   */
  assert.equal(scope.store.getState().noticesDropped, 5)
  scope.dispose()
})
test('a pushed report is shown as the host wrote it, not with its channel twice', () => {
  /*
   * **Measured on screen**: the notice read `variables: variables: trimmed 21
   * floor(s)…`. A host report already opens with its own channel — the same
   * rule this project applies everywhere, that the channel is a report's first
   * sentence — so a shell that prefixes `${kind}: ` says it twice.
   *
   * Asserted as a *count* rather than as an exact string, because the failure
   * is duplication and an equality check on the fixed text would also pass if
   * the prefix moved somewhere else in the sentence.
   */
  const scope = recordingStore()
  scope.push({
    type: 'report',
    irreversible: true,
    report: {
      grade: 'note',
      seq: 4,
      at: Date.now(),
      kind: 'variables',
      message: 'variables: trimmed 21 floor(s) in this chat',
    },
  })

  const text = String(scope.store.getState().notice?.text)
  assert.equal(text, 'variables: trimmed 21 floor(s) in this chat')
  assert.equal(text.match(/variables:/g)?.length, 1, `the channel was named twice: ${text}`)
  // And the durable copy says the same thing as the transient one.
  assert.equal(scope.store.getState().cardReports.at(-1)?.text, text)
  scope.dispose()
})
test('every answer puts the dialog away, including the one that reports nothing', async () => {
  /*
   * **Measured on 8789**: pressing "Do not remind me again" wrote
   * `ignore_cleanup: true` on the host within 2.5 s — so the call plainly
   * succeeded — and the dialog stayed on screen with all three buttons live.
   *
   * `never` is the answer that produces no notice, so it is the one whose
   * "something happened" evidence is *only* the dialog closing. The other two
   * were covered by their notice assertions and this one was not: a test that
   * checks the loud path and skips the quiet one leaves exactly this hole.
   */
  for (const answer of ['clean', 'never', 'backup-and-clean'] as const) {
    const scope = recordingStore()
    scope.push(OFFER)
    assert.ok(scope.store.getState().cleanupOffer !== undefined, answer)

    await actionsOf(scope.store).answerCleanup(answer)
    assert.equal(scope.store.getState().cleanupOffer, undefined, `${answer} left the dialog up`)
    scope.dispose()
  }
})

test('a repeated offer for a chat already answered is not shown again', async () => {
  /*
   * A guard on the shell rather than a claim about the host. The user answered;
   * a second offer for the same chat in the same session is not a new question,
   * and re-raising the dialog after an answer is indistinguishable from the
   * answer having failed.
   *
   * **Dismissal deliberately does not count as an answer here**: Esc means "ask
   * again", so a later offer for that chat must still be able to appear.
   */
  const scope = recordingStore()
  scope.push(OFFER)
  await actionsOf(scope.store).answerCleanup('never')
  scope.push(OFFER)
  assert.equal(scope.store.getState().cleanupOffer, undefined, 'the answered offer came back')

  const deferred = recordingStore()
  deferred.push(OFFER)
  actionsOf(deferred.store).dismissCleanupOffer()
  deferred.push(OFFER)
  assert.ok(
    deferred.store.getState().cleanupOffer !== undefined,
    'a deferred offer must be able to return',
  )
  scope.dispose()
  deferred.dispose()
})
test('an injection carries the run it belongs to, and only that call does', async () => {
  /*
   * The id is minted by the shell and never by the frame: a card has no idea
   * what a run is, and the id is what decides whose injections the host will
   * later delete. Only `setExtensionPrompt` takes one, because it is the only
   * card action that leaves something behind for a run to own.
   */
  const scope = recordingStore()
  actionsOf(scope.store).beginCardRun()
  const runId = scope.store.getState().cardRun?.runId
  assert.equal(runId, 'c1:1', 'the readable form is ${chatId}:${generation}')

  await actionsOf(scope.store).runCardAction('setExtensionPrompt', { key: 'k', value: 'v' })
  await actionsOf(scope.store).runCardAction('saveChat', {})

  const injection = scope.calls.find(it => it.method === 'script.setExtensionPrompt')
  assert.equal((injection?.params as Record<string, unknown>)['runId'], runId)
  const other = scope.calls.find(it => it.method === 'script.saveChat')
  assert.equal((other?.params as Record<string, unknown>)['runId'], undefined)
  scope.dispose()
})

test('ending a run reports it once, with the id the injection carried', async () => {
  /*
   * **Exactly once**, and that is the whole assertion. The frame's teardown and
   * `pagehide` can both reach this — a tab closing during a chat switch — and
   * the host answers with how many injections it cleared, so a second call
   * reports a second sweep of nothing.
   */
  const scope = recordingStore()
  actionsOf(scope.store).beginCardRun()
  const runId = scope.store.getState().cardRun?.runId
  await actionsOf(scope.store).runCardAction('setExtensionPrompt', { key: 'k', value: 'v' })

  await actionsOf(scope.store).endCardRun()
  await actionsOf(scope.store).endCardRun()

  const ended = scope.calls.filter(it => it.method === 'script.runEnded')
  assert.equal(ended.length, 1, 'runEnded was sent twice for one run')
  assert.deepEqual(ended[0]?.params, { chatId: 'c1', runId })
  assert.equal(scope.store.getState().cardRun?.runId, undefined)
  scope.dispose()
})

test('a new run gets a new id, so the old run’s injections are not adopted', async () => {
  // The generation is monotonic and the chat is part of the id, so two opens of
  // the same chat are two runs. If they shared an id, ending the second would
  // clear injections the first still owns — on another page, possibly.
  const scope = recordingStore()
  actionsOf(scope.store).beginCardRun()
  const first = scope.store.getState().cardRun?.runId
  actionsOf(scope.store).beginCardRun()
  const second = scope.store.getState().cardRun?.runId

  assert.notEqual(first, second)
  await actionsOf(scope.store).endCardRun()
  const ended = scope.calls.filter(it => it.method === 'script.runEnded')
  assert.equal((ended[0]?.params as Record<string, unknown>)['runId'], second,
    'ending the current run reported the previous one')
  scope.dispose()
})

test('a run that never started is not reported as ended', async () => {
  // Nothing was injected, so there is nothing for the host to clear, and a
  // `runEnded` for a run it never saw would be answered with a zero it has to
  // explain.
  const scope = recordingStore()
  await actionsOf(scope.store).endCardRun()
  assert.equal(scope.calls.some(it => it.method === 'script.runEnded'), false)
  scope.dispose()
})

test('a failed runEnded is silent here, because the host reports the orphan', async () => {
  /*
   * Teardown is the wrong moment for a notice: it would arrive over whatever
   * the reader is looking at next, about a run that has already gone. The host
   * keeps injections it was not told about and reports them itself — that
   * orphan report is why this can afford to be quiet.
   */
  const scope = recordingStore({ cleaned: 0, recorded: true }, 'script.runEnded')
  actionsOf(scope.store).beginCardRun()
  await actionsOf(scope.store).endCardRun()

  assert.equal(scope.store.getState().notice, undefined, 'teardown raised a notice')
  assert.equal(scope.store.getState().cardRun?.runId, undefined, 'the id survived a failed end')
  scope.dispose()
})
test('a run ends against its own chat, not the one now open', async () => {
  /*
   * **The bug the other five tests could not see, found in a browser.**
   *
   * `endCardRun` read `get().chatId`, and it runs from a React cleanup — which
   * fires *after* the store's `chatId` has already become the next chat. So on
   * every switch the shell sent a matched-looking pair whose halves belonged to
   * different conversations:
   *
   *   { chatId: '爱衣-…',  runId: '不要被神隐挑战-…:19' }   ← wrong chat
   *   { chatId: '爱衣-…',  runId: '爱衣-…:20' }            ← right, by luck
   *
   * The host matches a run by chat **and** id, so the mismatched half cleared
   * nothing and the previous run's injections stayed live — measured on 8787 as
   * exactly six, which is exactly what one V1.5.4 run injects.
   *
   * **Why the unit tests were green:** every one of them began and ended a run
   * without ever changing `chatId`, so the run's chat and the open chat were
   * the same string. The two sources were indistinguishable in the fixture, and
   * the assertion could not tell which one the code had read. Switching the
   * chat between begin and end is the whole discriminating power here.
   */
  const scope = recordingStore()
  actionsOf(scope.store).beginCardRun()
  const started = scope.store.getState().cardRun
  assert.deepEqual(started, { runId: 'c1:1', chatId: 'c1' })

  // The switch: the store learns the new chat before the old run's teardown.
  scope.store.setState({ chatId: 'c2' })
  await actionsOf(scope.store).endCardRun()

  const ended = scope.calls.filter(it => it.method === 'script.runEnded')
  assert.equal(ended.length, 1)
  assert.deepEqual(
    ended[0]?.params,
    { chatId: 'c1', runId: 'c1:1' },
    'the run was ended against the chat that is now open, not the one it ran in',
  )
  scope.dispose()
})

test('an injection uses the run’s id even after the open chat has moved on', async () => {
  /*
   * The same hazard on the other side of the pair. `runCardAction` sends
   * `chatId` from current state — correct, because a card's call is about the
   * chat it is running in — but the **run id** must stay the one minted when
   * the run began, or an injection would be filed under a run that never
   * existed and nothing would ever clear it.
   */
  const scope = recordingStore()
  actionsOf(scope.store).beginCardRun()
  scope.store.setState({ chatId: 'c2' })
  await actionsOf(scope.store).runCardAction('setExtensionPrompt', { key: 'k', value: 'v' })

  const injection = scope.calls.find(it => it.method === 'script.setExtensionPrompt')
  assert.equal((injection?.params as Record<string, unknown>)['runId'], 'c1:1')
  scope.dispose()
})
test('nothing is reported as dropped until something actually is', () => {
  // Exactly at the limit the log is full and complete. The push after it is the
  // first loss, and only then may the panel say so.
  const scope = recordingStore()
  for (let i = 0; i < NOTICE_LOG_LIMIT; i += 1) {
    actionsOf(scope.store).notify('info', `n${i}`)
  }
  assert.equal(scope.store.getState().noticeLog.length, NOTICE_LOG_LIMIT)
  assert.equal(scope.store.getState().noticesDropped, 0, 'a full log is not a lossy one')

  actionsOf(scope.store).notify('info', 'one more')
  assert.equal(scope.store.getState().noticesDropped, 1)
  scope.dispose()
})

test('identical notices inside the dedup window become one entry that counts itself', () => {
  /*
   * The case that set the window: a host restart drops the event socket and
   * the reconnect schedule raises the same sentence every few seconds. Four
   * identical rows is one outage counting itself, not four findings — so the
   * entry stays one and grows a ×N, and the bar still re-announces (a new seq).
   */
  const scope = recordingStore()
  const { notify } = actionsOf(scope.store)
  notify('error', 'the Iris event socket failed')
  notify('error', 'the Iris event socket failed')
  notify('error', 'the Iris event socket failed')

  const log = scope.store.getState().noticeLog
  assert.equal(log.length, 1)
  assert.equal(log[0]?.count, 3)
  // The bar re-announced on every recurrence: it shows the merged entry under
  // its newest seq, not the original one.
  assert.equal(scope.store.getState().notice?.seq, log[0]?.seq)
  assert.equal(scope.store.getState().noticesDropped, 0)
  scope.dispose()
})

test('a repeat whose only difference is its per-run address merges into the count', () => {
  /*
   * **The dedup the corpus defeated.** A card's scripts evaluate from a fresh
   * blob URL on every run, and a frame's error report quotes that URL with its
   * stack position — so the *same* bug arrived as a different sentence each
   * run, exact-text dedup collapsed nothing, and one recurring fault filled
   * the panel with rows that differed only by a UUID. Three re-opens of the
   * same card must read as one entry standing for three.
   */
  const scope = recordingStore()
  const { notify } = actionsOf(scope.store)
  notify('error', 'probe-throw: failed: uncaught failure at blob:null/aaaa-1111:3:7')
  notify('error', 'probe-throw: failed: uncaught failure at blob:null/bbbb-2222:3:7')
  notify('error', 'probe-throw: failed: uncaught failure at blob:null/cccc-3333:3:7')

  const log = scope.store.getState().noticeLog
  assert.equal(log.length, 1, 'the same fault with a new address is the same event')
  assert.equal(log[0]?.count, 3)
  // The row speaks the newest occurrence's words: `at` moved to now, and the
  // sentence should be the evidence for *that* occurrence, not the first.
  assert.match(log[0]?.text ?? '', /cccc-3333/)
  scope.dispose()
})

test('a fault that differs beyond its per-run address stays its own row', () => {
  // Normalisation is for addresses and nothing else. Two sentences that say
  // anything different about the cause are two findings, and merging them
  // would be the swallow the dedup exists to avoid.
  const scope = recordingStore()
  const { notify } = actionsOf(scope.store)
  notify('error', 'probe-throw: failed: uncaught failure at blob:null/aaaa-1111:3:7')
  notify('error', 'probe-refused: failed: member refused at blob:null/aaaa-1111:3:7')

  assert.equal(scope.store.getState().noticeLog.length, 2)
  assert.equal(scope.store.getState().noticeLog[0]?.count, undefined)
  scope.dispose()
})

test('a first error with a volatile address is never swallowed by the dedup', () => {
  // The one failure the mechanism must not have: a unique error normalized
  // into someone else's recurrence key. The blanking only ever applies to
  // `blob:` references; everything that makes a sentence itself is kept.
  const scope = recordingStore()
  const { notify } = actionsOf(scope.store)
  notify('error', 'mvu: variable schema rejected at blob:null/aaaa-1111:9:2')
  assert.equal(scope.store.getState().noticeLog.length, 1)
  assert.equal(scope.store.getState().notice?.kind, 'error')
  scope.dispose()

  assert.equal(noticeRecurrenceKey('plain failure, no address'), 'plain failure, no address')
})

test('a different notice does not merge, and the pure window check holds its edges', () => {
  const scope = recordingStore()
  const { notify } = actionsOf(scope.store)
  notify('error', 'the Iris event socket failed')
  notify('error', 'could not reach the Iris host: refused')
  assert.equal(scope.store.getState().noticeLog.length, 2)
  scope.dispose()

  const last: Notice = { kind: 'error', text: 'x', seq: 1, at: 1_000 }
  assert.equal(repeatsLatestNotice(last, 'error', 'x', undefined, 1_000 + NOTICE_DEDUP_WINDOW_MS - 1), true)
  assert.equal(repeatsLatestNotice(last, 'error', 'x', undefined, 1_000 + NOTICE_DEDUP_WINDOW_MS), false)
  // A different channel is a different species, whatever the words.
  assert.equal(repeatsLatestNotice(last, 'error', 'x', 'transport', 1_001), false)
  assert.equal(repeatsLatestNotice(undefined, 'error', 'x', undefined, 1_001), false)
})

test('a transport outage resolves itself when the connection returns', () => {
  /*
   * The socket failing during a host restart is expected, and the log should
   * say the outage *ended* — the difference between "something is wrong" and
   * "something was wrong". Marked, not deleted: the row is evidence.
   */
  const scope = recordingStore()
  const { notifyTransportError } = actionsOf(scope.store)
  notifyTransportError('the Iris event socket failed')

  scope.setConnected(false)
  assert.equal(scope.store.getState().connected, false)

  scope.setConnected(true)
  const log = scope.store.getState().noticeLog
  assert.equal(log[0]?.resolved, true, 'the outage is closed, not forgotten')
  // One closing line, and only because an outage actually logged an error.
  const closing = log[1]
  assert.equal(closing?.kind, 'info')
  assert.match(closing?.text ?? '', /Reconnected|重新连接/)
  scope.dispose()
})

test('a clean reconnect announces nothing', () => {
  // No outage, no closure to announce: noise is not information.
  const scope = recordingStore()
  scope.setConnected(false)
  scope.setConnected(true)
  assert.equal(scope.store.getState().noticeLog.length, 0)
  scope.dispose()
})

test('importPresetFiles answers per file — what landed, what was refused, and the list as of the last', async () => {
  const stub = stubClient()
  const answers: Record<string, unknown> = {
    'good.json': {
      outcome: { name: 'good', imported: true, overwritten: false, sensitive: [] },
      presets: [{ name: 'good' }],
    },
    'twin.json': {
      outcome: { name: 'good', imported: true, overwritten: true, sensitive: ['reverse_proxy'] },
      presets: [{ name: 'good' }],
    },
    'bad.json': {
      outcome: { name: 'bad', imported: false, reason: 'invalid-json' },
      presets: [{ name: 'good' }],
    },
  }
  const client: IrisClient = {
    ...stub.client,
    call: async (method, params) => {
      if (method === 'preset.importFile') {
        const answer = answers[(params as unknown as { filename: string }).filename]
        assert.ok(answer !== undefined, `unexpected filename ${(params as unknown as { filename: string }).filename}`)
        return answer as never
      }
      throw new Error(`unexpected ${method}`)
    },
  }
  const { store, dispose } = createIrisStore(client, TEST_SOURCE)

  const answer = await store.getState().importPresetFiles([
    { filename: 'good.json', base64: 'e30=' },
    { filename: 'twin.json', base64: 'e30=' },
    { filename: 'bad.json', base64: 'e30=' },
  ])

  assert.deepEqual(answer.imported, [
    { name: 'good', overwritten: false, sensitive: [] },
    { name: 'good', overwritten: true, sensitive: ['reverse_proxy'] },
  ])
  assert.deepEqual(answer.refused, [{ name: 'bad', reason: 'invalid-json' }])
  // The library in state is the last answer's, not a stale first read.
  assert.deepEqual(store.getState().presets, [{ name: 'good' }])
  assert.equal(store.getState().notice?.kind, 'info')
  assert.match(store.getState().notice?.text ?? '', /Imported 2 presets/)
  dispose()
})

test('a host without the file import answers honestly: nothing landed, and the refusal is the notice', async () => {
  // The fake client's refusal of `preset.importFile` — the guard raises it as
  // one notice, and no file invents an outcome it did not get.
  const { dispose, store } = createIrisStore(createFakeClient(), TEST_SOURCE)

  const answer = await store.getState().importPresetFiles([{ filename: 'x.json', base64: 'e30=' }])

  assert.deepEqual(answer.imported, [])
  assert.deepEqual(answer.refused, [])
  assert.equal(store.getState().notice?.kind, 'error')
  dispose()
})

test('the character page fetches its detail once per card, however often it asks', async () => {
  /*
   * The budget this action was written to. The page asks from an effect, so it
   * asks again on every re-render and on every language switch; the measured
   * precedent for getting this wrong is `script.context`, where a per-frame
   * fetch of 322 KB put the host 30 seconds behind on a cold page load.
   *
   * Counted per method, not in total: a guard that skipped only the book half
   * would still leave the script half firing on every render, and one number
   * would hide that.
   */
  const calls: string[] = []
  const stub = stubClient()
  const client: IrisClient = {
    ...stub.client,
    async call(method) {
      calls.push(method)
      if (method === 'worldbook.charDigest') return { books: [] } as never
      if (method === 'script.list') return { scripts: [], documentGranted: false } as never
      throw new Error(`unexpected ${method}`)
    },
  }
  const { store, dispose } = createIrisStore(client, TEST_SOURCE)

  await store.getState().loadCharacterDetail('luoluo')
  await store.getState().loadCharacterDetail('luoluo')
  await store.getState().loadCharacterDetail('luoluo')

  assert.equal(calls.filter(method => method === 'worldbook.charDigest').length, 1)
  assert.equal(calls.filter(method => method === 'script.list').length, 1)

  // A different card is a different question, and is asked.
  await store.getState().loadCharacterDetail('aria-vance')
  assert.equal(calls.filter(method => method === 'worldbook.charDigest').length, 2)
  assert.equal(store.getState().characterDetail?.characterId, 'aria-vance')
  dispose()
})

test('a host that refuses the detail leaves the page as it was, with no error banner', async () => {
  /*
   * Both halves are refusable by configuration: a host with no world book store
   * refuses `worldbook.charDigest`, one with no script policy can refuse
   * `script.list`. Neither is a fault, and a page opened on such a host must
   * not greet the reader with an error about a feature it never had — the same
   * line `loadPresets` and `loadRegexScripts` draw.
   *
   * `undefined` after the fetch settles is the answer, and it is deliberately
   * not an empty list: an empty list would read as "this card has no books",
   * which is a claim about the card rather than about the host.
   */
  const stub = stubClient()
  const client: IrisClient = {
    ...stub.client,
    call: async () => {
      throw Object.assign(new Error('this host keeps no world book store'), { code: 'not-found' })
    },
  }
  const { store, dispose } = createIrisStore(client, TEST_SOURCE)

  await store.getState().loadCharacterDetail('luoluo')

  const detail = store.getState().characterDetail
  assert.equal(detail?.characterId, 'luoluo')
  assert.equal(detail?.loading, false, 'the column would say "reading the card" forever')
  assert.equal(detail?.books, undefined)
  assert.equal(detail?.scripts, undefined)
  assert.equal(store.getState().notice, undefined, 'browsing a card raised an error notice')
  dispose()
})

test('browsing a card does not move the open chat’s script slice', async () => {
  /*
   * `scripts` / `scriptsFor` / `scriptsAllowed` describe the card whose
   * conversation is open, and the consent answer travels with them. Writing
   * them from a page that is merely being *looked at* would report one card's
   * authorisation under another card's name — and, through `ConsentAsk`, could
   * put the run-scripts question about a card nobody opened. So the page's
   * fetch lands in its own slice, and this holds that line.
   */
  const stub = stubClient()
  const client: IrisClient = {
    ...stub.client,
    async call(method) {
      if (method === 'worldbook.charDigest') return { books: [] } as never
      if (method === 'script.list') {
        return {
          scripts: [{ id: 's1', name: 'browsed card script', enabledByCard: true, enabled: true, bytes: 10 }],
          documentGranted: true,
          scriptsAllowed: true,
        } as never
      }
      throw new Error(`unexpected ${method}`)
    },
  }
  const { store, dispose } = createIrisStore(client, TEST_SOURCE)
  store.setState({ scripts: [], scriptsFor: 'the-open-card', scriptsAllowed: 'declined', documentGranted: false })

  await store.getState().loadCharacterDetail('some-other-card')

  assert.equal(store.getState().scriptsFor, 'the-open-card')
  assert.deepEqual(store.getState().scripts, [])
  assert.equal(store.getState().scriptsAllowed, 'declined')
  assert.equal(store.getState().documentGranted, false, 'a browsed card handed its page grant to the open one')
  // …while the page's own slice did get the answer.
  assert.equal(store.getState().characterDetail?.scripts?.length, 1)
  dispose()
})

test('a script switched off in the panel reaches the card page’s own copy', async () => {
  /*
   * Two surfaces hold the same list: `scripts` (the open chat's card, which the
   * panel edits) and `characterDetail.scripts` (whatever card is being
   * browsed). When they are the same card, a switch flipped in the panel has to
   * reach both, or the page goes on saying 「you switched it off」 about a script
   * the reader has just switched back on — a stale read with nothing on screen
   * to suggest it.
   *
   * Written from the write's own answer rather than re-fetched: `script.setEnabled`
   * hands back the whole list for that card.
   */
  const stub = stubClient()
  const client: IrisClient = {
    ...stub.client,
    async call(method, params) {
      if (method === 'worldbook.charDigest') return { books: [] } as never
      if (method === 'script.list') {
        return {
          scripts: [{ id: 's1', name: 'panel script', enabledByCard: true, enabled: true, bytes: 10 }],
          documentGranted: false,
        } as never
      }
      if (method === 'script.setEnabled') {
        const asked = params as unknown as { enabled: boolean }
        return {
          scripts: [{ id: 's1', name: 'panel script', enabledByCard: true, enabled: asked.enabled, bytes: 10 }],
        } as never
      }
      throw new Error(`unexpected ${method}`)
    },
  }
  const { store, dispose } = createIrisStore(client, TEST_SOURCE)

  await store.getState().loadCharacterDetail('aria')
  store.setState({ scriptsFor: 'aria' })
  assert.equal(store.getState().characterDetail?.scripts?.[0]?.enabled, true)

  await store.getState().setScriptEnabled('s1', false)

  assert.equal(store.getState().characterDetail?.scripts?.[0]?.enabled, false)
  // …and a page open on a *different* card is left alone: the two surfaces are
  // only one fact when they name the same card.
  store.setState({ characterDetail: { characterId: 'someone-else', loading: false, books: undefined, scripts: [] } })
  await store.getState().setScriptEnabled('s1', true)
  assert.deepEqual(store.getState().characterDetail?.scripts, [])
  dispose()
})

// —— family④: lorebook / worldbook ——
test('a character rebind is addressed to the open card, whatever the frame sent', async () => {
  /*
   * `worldbook.setCharBooks` takes a `characterId`, and the frame is the
   * untrusted side: a card that supplied one could rewrite the bindings of a
   * character the user did not open. The two members that reach this arm
   * (`rebindCharWorldbooks`, `setCurrentCharLorebooks`) accept only
   * `'current'`, and this layer is the one that knows which character that is —
   * the same division `runId` above is filled in under.
   *
   * The frame's own value is sent here **on purpose**: the assertion is not that
   * a well-behaved frame is passed through, it is that a misbehaving one is
   * overridden. That depends on the spread order, which is a one-character edit
   * away from being wrong and has nothing else watching it.
   */
  const scope = recordingStore()
  scope.store.setState({
    view: { chatId: 'c1', title: 'A scene', messages: [], characterId: 'aria' },
  })

  await actionsOf(scope.store).runCardAction('rebindCharWorldbooks', {
    names: ['Extra'],
    characterId: 'someone-else',
  })

  const call = scope.calls.find(it => it.method === 'worldbook.setCharBooks')
  assert.deepEqual(call?.params, { chatId: 'c1', names: ['Extra'], characterId: 'aria' })
  scope.dispose()
})
