/**
 * A frame realm made of stubs, reduced to what a sandbox plugin's card surface
 * needs: the real `installSandbox`, the real member table, and the channel.
 *
 * `sandbox-frame.test.ts` has the full harness. This one exists so the plugin
 * tests can hold the surface `cardSurface` really returns, and can read the
 * `call` messages it really posts, without a document.
 *
 * @module iris-web/tests/plugin-owner-realm
 */
import type { ScriptContext } from '@iris/protocol'

import { installSandbox, type FrameEnv, type FrameSandbox } from '../src/sandbox/frame.ts'
import type { FromFrame, ToFrame } from '../src/sandbox/protocol.ts'
import { MEMBERS } from './members-table.ts'

/** What a test gets back. */
export interface PluginRealm {
  sandbox: FrameSandbox
  posted: FromFrame[]
  send: (message: ToFrame) => void
  /** The `call` messages posted so far, as `method` and `params`. */
  calls: () => { method: string, params: Record<string, unknown> }[]
}

/**
 * A snapshot for one conversation with one card.
 * @param chatId - the conversation.
 * @param overrides - fields to change.
 * @returns the context.
 */
export function contextFor(chatId: string, overrides: Record<string, unknown> = {}): ScriptContext {
  return {
    chat: [{ mes: 'hello', is_user: false, swipes: ['hello'], swipe_id: 0 }],
    chatMetadata: {},
    name1: 'You',
    name2: 'Aria',
    characterId: 'aria',
    chatId,
    characters: [],
    extensionSettings: {},
    variables: {},
    ...overrides,
  } as never
}

/**
 * Install a frame and hand it a context.
 * @param context - the snapshot, or none.
 * @returns the realm.
 */
export function pluginRealm(context?: ScriptContext): PluginRealm {
  const posted: FromFrame[] = []
  const listeners: ((message: ToFrame) => void)[] = []
  const env: FrameEnv = {
    members: MEMBERS,
    token: 'tok',
    container: { id: 'card-root', querySelector: () => null, querySelectorAll: () => [] } as never,
    factory: {
      createElement: tagName => ({ tagName: String(tagName).toUpperCase(), style: {}, setAttribute: () => undefined }),
      createTextNode: data => ({ data }),
      createDocumentFragment: () => ({ fragment: true }),
    },
    realWindow: {},
    post: message => posted.push(message),
    onMessage: listener => listeners.push(listener),
    evaluate: () => undefined,
  }
  const sandbox = installSandbox(env)
  const send = (message: ToFrame): void => listeners.forEach(listener => listener(message))
  if (context !== undefined) send({ iris: 'tok', type: 'context', context })
  return {
    sandbox,
    posted,
    send,
    calls: () => posted
      .filter((message): message is Extract<FromFrame, { type: 'call' }> => message.type === 'call')
      .map(message => ({ method: message.method, params: message.params as Record<string, unknown> })),
  }
}
