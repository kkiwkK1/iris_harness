/**
 * A sandbox plugin's per-card state belongs to one conversation.
 *
 * Finding `sandbox-plugin-state-keyed-per-card`. Plugin ids are minted unique
 * within a conversation only, so the first plugin with prefix `x` is `01-x` in
 * every chat. The host keeps script-scope variables per `(characterId,
 * scriptId)`. Under the bare plugin id, two conversations with the same card
 * therefore shared one table, and it outlived both the plugin and the chat.
 * The frame now binds a plugin's surface as `sp:<chatId>:<pluginId>`
 * (`sandboxPluginOwnerId`). These tests hold the host half of that: isolation,
 * forget on remove, forget on chat delete, and copy on branch.
 *
 * Script buttons are the other per-card store the finding named. The host
 * already refuses a button write for any id the card does not declare, so a
 * plugin owner never has a table there. The last test pins that refusal,
 * because `owner-state.ts` relies on it to leave buttons out.
 *
 * @module @iris/app-service/tests/sandbox-plugin-owner-state
 */
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

import { sandboxPluginOwnerId } from '@iris/protocol'

import { ChatStore } from '../src/chats.ts'
import { ScriptButtonStore } from '../src/script-buttons.ts'
import { ScriptVariableStore } from '../src/script-variables.ts'
import type { Handlers } from '../src/service.ts'
import { SandboxPluginStore, type SandboxPluginRecord } from '../src/sandbox-plugins/store.ts'
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

/** The same plugin id in both chats, which is the collision the finding measured. */
const PLUGIN = '01-x'

/**
 * One authorised plugin row.
 * @param id - the plugin id.
 * @returns the record.
 */
function row(id: string): SandboxPluginRecord {
  return {
    id,
    versions: [{
      version: 1, name: 'x', purpose: 'p', declares: [],
      code: 'return {}', bytes: 9, hash: 'h1', prompt: 's',
      authored: { connectionId: 'c', model: 'm', at: 1 },
    }],
    enabled: true, trustFutureVersions: false, authorizedHashes: ['h1'],
  }
}

interface Fixture {
  handlers: Handlers
  variables: ScriptVariableStore
  plugins: SandboxPluginStore
  dir: string
  chatA: string
  chatB: string
}

/**
 * A host with one card and two conversations with it, each holding plugin `01-x`.
 * @param t - the test context.
 * @returns the fixture.
 */
async function fixture(t: TestContext): Promise<Fixture> {
  let variables: ScriptVariableStore | undefined
  let plugins: SandboxPluginStore | undefined
  const built = await createTestService(t, async ({ dir, library }) => {
    await mkdir(join(dir, 'characters'), { recursive: true })
    await writeFile(join(dir, 'characters', 'aria.json'), CARD, 'utf8')
    variables = new ScriptVariableStore(join(dir, 'script-variables.json'))
    plugins = new SandboxPluginStore(join(dir, 'sandbox-plugins'))
    return {
      scriptVariables: variables,
      scriptButtons: new ScriptButtonStore(join(dir, 'script-buttons.json')),
      sandboxPlugins: plugins,
      chats: new ChatStore(join(dir, 'chats'), library, variables),
    }
  }, 'iris-plugin-owner-')
  if (variables === undefined || plugins === undefined) throw new Error('the override did not run')
  const handlers = built.handlers
  const chatA = (await handlers['chat.create']({ characterId: 'aria' })).view.chatId
  const chatB = (await handlers['chat.create']({ characterId: 'aria' })).view.chatId
  assert.notEqual(chatA, chatB)
  await plugins.mutate(chatA, 'aria', () => [row(PLUGIN)])
  await plugins.mutate(chatB, 'aria', () => [row(PLUGIN)])
  return { handlers, variables, plugins, dir: built.dir, chatA, chatB }
}

/**
 * Write a plugin's script-scope variables the way its frame does.
 * @param fixed - the fixture.
 * @param chatId - the conversation the plugin runs in.
 * @param variables - what to write.
 */
async function write(fixed: Fixture, chatId: string, variables: Record<string, unknown>): Promise<void> {
  await fixed.handlers['script.setVariables']({
    chatId, scope: 'script', scriptId: sandboxPluginOwnerId(chatId, PLUGIN), op: 'replace', variables,
  })
}

/**
 * Read a plugin's script-scope variables as the host holds them.
 * @param fixed - the fixture.
 * @param chatId - the conversation.
 * @returns the table.
 */
async function read(fixed: Fixture, chatId: string): Promise<Record<string, unknown>> {
  const answer = await fixed.handlers['script.getVariables']({
    chatId, scope: 'script', scriptId: sandboxPluginOwnerId(chatId, PLUGIN),
  })
  return answer.variables
}

test('two conversations with the same card and the same plugin id keep separate tables', async t => {
  const fixed = await fixture(t)
  await write(fixed, fixed.chatA, { turns: 7 })
  await write(fixed, fixed.chatB, { theme: 'dark' })

  /*
   * The tooth is to bind the bare plugin id (the pre-fix `viewFor(owner)` in
   * `frame.ts`), which is `sandboxPluginOwnerId` returning `pluginId`: then
   * both writes land in `aria`/`01-x` and B's replace erases A's count.
   */
  assert.deepEqual(await read(fixed, fixed.chatA), { turns: 7 })
  assert.deepEqual(await read(fixed, fixed.chatB), { theme: 'dark' })
})

test('removing the plugin in one conversation forgets its table and leaves the other intact', async t => {
  const fixed = await fixture(t)
  await write(fixed, fixed.chatA, { turns: 7 })
  await write(fixed, fixed.chatB, { theme: 'dark' })

  await fixed.handlers['sandboxPlugin.decide']({
    chatId: fixed.chatA, characterId: 'aria', pluginId: PLUGIN, verdict: 'remove',
  })

  // Gone from the file, not merely unread: the next plugin minted `01-x` in
  // chat A (ids are recycled) must start empty. The tooth is the
  // `forgetPluginState` line in `sandboxPlugin.decide`.
  const stored = JSON.parse(await readFile(join(fixed.dir, 'script-variables.json'), 'utf8')) as
    Record<string, Record<string, unknown>>
  assert.equal(stored['aria']?.[sandboxPluginOwnerId(fixed.chatA, PLUGIN)], undefined)
  assert.deepEqual(await read(fixed, fixed.chatA), {})
  // Chat B's plugin of the same id was not touched.
  assert.deepEqual(await read(fixed, fixed.chatB), { theme: 'dark' })

  // Disable is not remove: the state stays with a switched-off plugin.
  await fixed.handlers['sandboxPlugin.decide']({
    chatId: fixed.chatB, characterId: 'aria', pluginId: PLUGIN, verdict: 'disable',
  })
  assert.deepEqual(await read(fixed, fixed.chatB), { theme: 'dark' })
})

test('deleting a conversation forgets every plugin owner it had, and only those', async t => {
  const fixed = await fixture(t)
  await write(fixed, fixed.chatA, { turns: 7 })
  await write(fixed, fixed.chatB, { theme: 'dark' })

  await fixed.handlers['chat.delete']({ chatId: fixed.chatA })

  // The tooth is the `forgetChatPluginState` line in `chat.delete`.
  const stored = JSON.parse(await readFile(join(fixed.dir, 'script-variables.json'), 'utf8')) as
    Record<string, Record<string, unknown>>
  const owners = Object.keys(stored['aria'] ?? {})
  assert.deepEqual(owners, [sandboxPluginOwnerId(fixed.chatB, PLUGIN)])
})

test('a branch copies each plugin’s table, and the two roads then diverge', async t => {
  const fixed = await fixture(t)
  await write(fixed, fixed.chatA, { turns: 7 })

  const branched = await fixed.handlers['chat.branch']({ chatId: fixed.chatA, id: 0 })
  const child = branched.view.chatId

  // The row came with its authorisation (store test), so its state comes too.
  assert.deepEqual(await read(fixed, child), { turns: 7 })

  // A copy, not a reference: writing the branch leaves the parent alone.
  await write(fixed, child, { turns: 8 })
  assert.deepEqual(await read(fixed, fixed.chatA), { turns: 7 })
  assert.deepEqual(await read(fixed, child), { turns: 8 })
})

test('a plugin owner cannot store script buttons, so there is no button table to forget', async t => {
  const fixed = await fixture(t)
  /*
   * `owner-state.ts` leaves the button store out of forget and copy because of
   * this refusal. If the declared-script check in `script.replaceScriptButtons`
   * is ever relaxed, this goes red, and the button table then needs the same
   * forget, copy and isolation as the variables above.
   */
  await assert.rejects(
    fixed.handlers['script.replaceScriptButtons']({
      chatId: fixed.chatA,
      characterId: 'aria',
      scriptId: sandboxPluginOwnerId(fixed.chatA, PLUGIN),
      buttons: [{ name: 'Roll', visible: true }],
    }),
    (error: unknown) => (error as { code?: string }).code === 'not-found',
  )
})
