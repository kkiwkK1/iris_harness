/**
 * A sandbox plugin's version says which facade it was written for.
 *
 * Finding `sandbox-facade-unversioned`. Stamped by the host at define time
 * from `SANDBOX_PLUGIN_FACADE_VERSION`, never from the model's output. A
 * version stamped above this build's facade is refused by name
 * (`facade-mismatch`) rather than mounted and left to fail as `mount-failed`
 * on the first member the build lacks. Absent reads as 1, the only facade that
 * shipped before the stamp.
 *
 * @module @iris/app-service/tests/sandbox-plugin-facade
 */
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'

import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { isSandboxPluginFailureState, SANDBOX_PLUGIN_FACADE_VERSION } from '@iris/protocol'
import type { StreamFn } from '@iris/turn'

import { ConnectionStore } from '../src/connections.ts'
import {
  mountsOf,
  SandboxPluginStore,
  viewOf,
  type SandboxPluginRecord,
  type SandboxPluginVersionRecord,
} from '../src/sandbox-plugins/store.ts'
import { createTestService } from './support/service.ts'

const CARD = JSON.stringify({
  spec: 'chara_card_v2',
  spec_version: '2.0',
  data: {
    name: 'Aria', description: '', personality: '', scenario: '',
    first_mes: 'Hello.', mes_example: '', creator_notes: '', system_prompt: '',
    post_history_instructions: '', alternate_greetings: [], tags: [],
    creator: '', character_version: '1',
    extensions: {},
  },
})

/**
 * One authorised plugin whose current version carries the given stamp.
 * @param facade - the stamp, or undefined for a version from before stamps.
 * @returns the record.
 */
function stamped(facade: number | undefined): SandboxPluginRecord {
  const version: SandboxPluginVersionRecord = {
    version: 1, name: 'x', purpose: 'p', declares: [],
    code: 'return {}', bytes: 9, hash: 'h1', prompt: 's',
    authored: { connectionId: 'c', model: 'm', at: 1 },
    ...facade === undefined ? {} : { facade },
  }
  return { id: '01-x', versions: [version], enabled: true, trustFutureVersions: false, authorizedHashes: ['h1'] }
}

test('a version stamped for a newer facade is refused by name and not handed to the frame', () => {
  const newer = stamped(SANDBOX_PLUGIN_FACADE_VERSION + 1)

  // The tooth: drop the `facadeMounts` line in `mountsOf`, and the code of a
  // plugin written for a surface this build does not have goes to the frame.
  assert.deepEqual(mountsOf([newer]), [])
  const view = viewOf(newer)
  assert.equal(view.failure?.state, 'facade-mismatch')
  assert.match(view.failure?.detail ?? '', /facade 2.*facade 1/u)
  // A state the wire validator knows, so the panel and a shell parse accept it.
  assert.ok(isSandboxPluginFailureState('facade-mismatch'))

  // The control: this build's own facade, and an unstamped version, mount.
  assert.equal(mountsOf([stamped(SANDBOX_PLUGIN_FACADE_VERSION)]).length, 1)
  assert.equal(mountsOf([stamped(undefined)]).length, 1, 'absent must read as 1')
  assert.equal(viewOf(stamped(undefined)).failure, undefined)
})

test('the stamp survives the sidecar, and a malformed one reads as absent', async t => {
  const built = await createTestService(t, {}, 'iris-plugin-facade-')
  const store = new SandboxPluginStore(join(built.dir, 'sandbox-plugins'))
  await store.mutate('c1', 'aria', () => [stamped(2)])
  assert.equal((await store.read('c1'))[0]?.versions[0]?.facade, 2)

  // A hand-edited stamp that is not a positive integer is dropped, not trusted.
  const path = join(built.dir, 'sandbox-plugins', 'c1.json')
  const file = JSON.parse(await readFile(path, 'utf8')) as { plugins: { versions: { facade?: unknown }[] }[] }
  const first = file.plugins[0]?.versions[0]
  if (first !== undefined) first.facade = 'latest'
  await writeFile(path, JSON.stringify(file), 'utf8')
  assert.equal((await store.read('c1'))[0]?.versions[0]?.facade, undefined)
})

test('define stamps the host’s facade, whatever the model wrote', async t => {
  /*
   * The model's reply names a `facade` of its own, in both the metadata block
   * and the code. The host must ignore both: the stamp is a statement about the
   * build that parked the version, not something the untrusted side may set.
   */
  const reply = [
    '```json',
    JSON.stringify({ idPrefix: 'x', name: 'x', purpose: 'p', declares: [], facade: 99 }),
    '```',
    '```js',
    'return { facade: 99, apply() {} }',
    '```',
  ].join('\n')
  const stream: StreamFn = async function* (_request: GenerateOptions): AsyncIterable<StreamChunk> {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: reply }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: reply } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  let plugins: SandboxPluginStore | undefined
  const built = await createTestService(t, async ({ dir }) => {
    await mkdir(join(dir, 'characters'), { recursive: true })
    await writeFile(join(dir, 'characters', 'aria.json'), CARD, 'utf8')
    const connections = new ConnectionStore(join(dir, 'connections.json'))
    const saved = await connections.save({ provider: 'test', model: 'writer-1' })
    const id = saved.profiles[0]?.id ?? ''
    await connections.markActive(id)
    await connections.setAuthoring({ id, model: 'writer-1' })
    plugins = new SandboxPluginStore(join(dir, 'sandbox-plugins'))
    return { stream, connections, sandboxPlugins: plugins }
  }, 'iris-plugin-facade-')
  if (plugins === undefined) throw new Error('the override did not run')

  const chatId = (await built.handlers['chat.create']({ characterId: 'aria' })).view.chatId
  await built.handlers['sandboxPlugin.define']({ chatId, characterId: 'aria', sentence: 'do x' })

  // The tooth: drop `facade: SANDBOX_PLUGIN_FACADE_VERSION` from the define
  // path, and the stored version is unstamped.
  const stored = (await plugins.read(chatId))[0]?.versions.at(-1)
  assert.equal(stored?.facade, SANDBOX_PLUGIN_FACADE_VERSION)
})
