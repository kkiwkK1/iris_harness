/**
 * The shell's half of a 「create」 sentence: what it sends, and what it shows.
 *
 * Between the composer and the host there is one store action, and it is the
 * piece that can be got wrong invisibly — the composer cannot see the host's
 * answer, and a refusal rewritten on the way through looks exactly like a
 * refusal that said nothing useful.
 *
 * The sentence rule is here because the acceptance run measured it going wrong:
 * item 6 put a model's syntax error in front of a reader as 「Iris 不会发送这个
 * 请求」 — `describeError`'s general copy for `invalid-request`, which is right
 * where the detail is an identifier ("no chat \"chat-7\"") and wrong here, where
 * the detail is the whole of what a reader can act on (`docs/SANDBOX-PLUGINS.md`
 * §6.1 asks for a sentence naming the fault, beside a retry entry).
 *
 * @module iris-web/tests/sandbox-plugin-store
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createFakeClient } from '@iris/client-fake'
import type { IrisClient } from '@iris/protocol'

import { createIrisStore } from '../src/client/store.ts'

interface RecordedCall { method: string, params: unknown }

/** A wired store whose client records every call and can refuse one by name. */
function wired(options: { refuse?: { method: string, code: string, message: string } } = {}): {
  store: ReturnType<typeof createIrisStore>['store']
  calls: RecordedCall[]
  dispose: () => void
} {
  const client = createFakeClient({ chunkDelayMs: 0 })
  const calls: RecordedCall[] = []
  const recorder = {
    call: async (method: string, params: unknown) => {
      calls.push({ method, params })
      if (options.refuse?.method === method) {
        // Shaped like the transport's own rejection: an `Error` carrying a
        // `code`, which is what `asRpcError` reads.
        const error = new Error(options.refuse.message) as Error & { code: string }
        error.code = options.refuse.code
        throw error
      }
      return await (client as unknown as { call: (m: string, p: unknown) => Promise<unknown> }).call(method, params)
    },
    subscribe: (listener: Parameters<IrisClient['subscribe']>[0]) => client.subscribe(listener),
    get connected() { return client.connected },
    onConnectionChange: (listener: Parameters<IrisClient['onConnectionChange']>[0]) =>
      client.onConnectionChange(listener),
  } as unknown as IrisClient
  const { store, dispose } = createIrisStore(recorder, { transport: 'fake', origin: 'sandbox plugin store test' })
  store.setState({ chatId: 'chat-7', view: { characterId: 'aria' } as never })
  return { store, calls, dispose: () => { dispose(); client.dispose() } }
}

test('a 「create」 sentence reaches the host with the conversation it was said in', async () => {
  const { store, calls, dispose } = wired()
  await store.getState().defineSandboxPlugin('加一个显示回合数的小面板')
  const call = calls.find(entry => entry.method === 'sandboxPlugin.define')
  assert.ok(call !== undefined, 'the sentence never reached the host')
  assert.deepEqual(call.params, {
    chatId: 'chat-7',
    characterId: 'aria',
    sentence: '加一个显示回合数的小面板',
  })
  dispose()
})

test('a refusal keeps the host\'s own words, so the retry entry has something to explain', async () => {
  const detail = "the model's code does not compile — SyntaxError: Unexpected token ')'"
  const { store, dispose } = wired({
    refuse: { method: 'sandboxPlugin.define', code: 'invalid-request', message: detail },
  })
  await store.getState().defineSandboxPlugin('写一个会坏掉的插件')

  const refusal = store.getState().sandboxPluginRefusal
  assert.ok(refusal !== undefined, 'a refusal left nothing for the retry entry to hang off')
  /*
   * The **host's** sentence, not the general copy for the code. The acceptance
   * run showed a reader the general one, which names no fault and suggests no
   * next step. The tooth is to put `describeError` back in that line: it
   * answers 「Iris would not send that.」 and this goes red.
   */
  assert.equal(refusal.detail, detail)
  // And the sentence, so pressing 「try again」 sends what was said rather than
  // asking the reader to type it out a second time.
  assert.equal(refusal.sentence, '写一个会坏掉的插件')
  // Nothing was parked: a refused definition must not leave a confirmation card
  // in front of a reader who has nothing to confirm.
  assert.equal(store.getState().sandboxPluginPending, undefined)
  // And the composer is usable again, whatever happened.
  assert.equal(store.getState().sandboxPluginWorking, false)
  dispose()
})

test('a conversation with no plugins reads as empty rather than as a host that has none', async () => {
  /*
   * The fake client refuses `sandboxPlugin.list` by name — it keeps no sidecar —
   * and the action swallows that on purpose: raising it would put a red bar over
   * every conversation opened on a host composed without the store. What must
   * not happen is a stale list surviving the refusal.
   */
  const { store, calls, dispose } = wired()
  store.setState({ sandboxPlugins: [{ id: 'stale' } as never], sandboxPluginsFor: 'chat-6' })
  await store.getState().loadSandboxPlugins('chat-7')
  assert.ok(calls.some(entry => entry.method === 'sandboxPlugin.list'), 'the host was never asked')
  assert.deepEqual(store.getState().sandboxPlugins, [])
  assert.deepEqual(store.getState().sandboxPluginMounts, [])
  assert.equal(store.getState().sandboxPluginsFor, 'chat-7')
  dispose()
})
