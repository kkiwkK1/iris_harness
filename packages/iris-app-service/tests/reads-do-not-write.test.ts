import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { IrisEvent, RpcMethod } from '@iris/protocol'
import type { StreamFn } from '@iris/turn'

import { ChatStore } from '../src/chats.ts'
import { ExtensionSettingsStore } from '../src/context.ts'
import { CharacterLibrary } from '../src/library.ts'
import { ScriptPolicyStore } from '../src/scripts.ts'
import { ScriptVariableStore } from '../src/script-variables.ts'
import { IrisAppService, type Handlers } from '../src/service.ts'
import { SettingsStore } from '../src/settings.ts'

/**
 * A method that reads must not write.
 *
 * This exists because the rule was learned the expensive way, twice. Binding the
 * macro tier to the chat's persistent scopes turned `prompt.itemize` — a
 * preview — into a write that stored a preset's menu selections into
 * `chat_metadata.variables`; and assembling a prompt for a card-initiated
 * generation would have advanced the world-info timed effects and overwritten a
 * real turn's itemization. Both were caught by looking, and looking does not
 * scale.
 *
 * So the check is empirical rather than a code review: call every read-shaped
 * method against a conversation with real state in it, and compare everything
 * observable before and after — the chat file, the view, all four variable
 * scopes, the timed effects, the itemizations, and the bytes on disk.
 *
 * The failures it is built to catch are the quiet kind. A preview that writes
 * does not error; it leaves a chat that behaves differently later, and the
 * change surfaces turns afterwards with nothing pointing back to the read that
 * caused it.
 */

const CARD = JSON.stringify({
  spec: 'chara_card_v2',
  spec_version: '2.0',
  data: {
    name: 'Aria', description: 'A retired cartographer.', personality: '', scenario: '',
    first_mes: 'Hello.', mes_example: '', creator_notes: '', system_prompt: '',
    post_history_instructions: '', alternate_greetings: [], tags: [],
    creator: '', character_version: '1',
    extensions: {
      tavern_helper: {
        scripts: [{ id: 'panel', name: 'Panel', type: 'script', enabled: true, content: 'noop()' }],
      },
    },
    character_book: {
      entries: [
        {
          keys: [], content: 'count: 0', comment: '[InitVar]', name: '[InitVar]',
          enabled: false, constant: false, insertion_order: 0, extensions: {},
        },
        {
          keys: [], content: 'The maps are in the west tower.',
          enabled: true, constant: true, insertion_order: 1,
          extensions: { position: 4, depth: 0, role: 0, sticky: 3 },
        },
      ],
    },
  },
})

interface Fixture {
  handlers: Handlers
  chats: ChatStore
  chatId: string
  dir: string
  /** The script-variable store, whose writes are queued rather than awaited. */
  scriptVariables: ScriptVariableStore
}

async function fixture(t: TestContext): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), 'iris-reads-'))
  t.after(async () => { await rm(dir, { recursive: true, force: true }) })
  await mkdir(join(dir, 'characters'), { recursive: true })
  await writeFile(join(dir, 'characters', 'aria.json'), CARD, 'utf8')

  const library = new CharacterLibrary(join(dir, 'characters'), '/iris/avatar')
  const scriptVariables = new ScriptVariableStore(join(dir, 'script-variables.json'))
  const chats = new ChatStore(join(dir, 'chats'), library, scriptVariables)
  let ends = 0
  const stream: StreamFn = async function* (_options: GenerateOptions): AsyncIterable<StreamChunk> {
    const text = "Noted. _.set('count', 1);"
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  const handlers = new IrisAppService({
    stream, library, chats, scriptVariables,
    settings: new SettingsStore(join(dir, 'settings.json'), { provider: 'test', model: 'test-model' }),
    scripts: new ScriptPolicyStore(join(dir, 'script-policy.json')),
    extensionSettings: new ExtensionSettingsStore(join(dir, 'extension-settings.json')),
    broadcast: (event: IrisEvent) => { if (event.type === 'stream.end') ends += 1 },
    userName: 'Traveller',
  }).handlers()

  // A conversation with state worth not disturbing: a folded variable table, a
  // sticky world-info window, an itemization, and something on disk.
  const created = await handlers['chat.create']({ characterId: 'aria' })
  const chatId = created.view.chatId
  await handlers['chat.send']({ chatId, text: 'Where are the maps?' })
  while (ends < 1) await new Promise(resolve => setTimeout(resolve, 1))

  return { handlers, chats, chatId, dir, scriptVariables }
}

/** Everything observable about a conversation and its store. */
async function snapshot(fixed: Fixture): Promise<string> {
  // Settled first. `ScriptVariableStore` queues its writes instead of awaiting
  // them, so a flush from earlier setup can land between the two snapshots and
  // look exactly like a read that wrote. That is not hypothetical — it made this
  // very test fail on one run in three, and an intermittent assertion is worse
  // than a failing one because it teaches the reader to re-run instead of look.
  await fixed.scriptVariables.settled()
  const entry = await fixed.chats.open(fixed.chatId)
  const files: Record<string, string> = {}
  const walk = async (at: string, prefix: string): Promise<void> => {
    let names: string[]
    try {
      names = await readdir(at, { withFileTypes: true }).then(items => items.map(item => item.name))
    } catch {
      return
    }
    for (const name of names) {
      const path = join(at, name)
      try {
        files[`${prefix}${name}`] = await readFile(path, 'utf8')
      } catch {
        await walk(path, `${prefix}${name}/`)
      }
    }
  }
  await walk(fixed.dir, '')

  return JSON.stringify({
    file: entry.toFile(),
    view: entry.toView(),
    timedEffects: entry.timedEffects ?? null,
    itemizations: [...entry.itemizations.entries()],
    events: entry.session.events.length,
    variables: {
      message: entry.currentVariables() ?? null,
      chat: entry.variables.getVariables({ type: 'chat' }),
      global: entry.variables.getVariables({ type: 'global' }),
      script: entry.variables.getVariables({ type: 'script', script_id: 'panel' }),
    },
    files,
  })
}

/**
 * The methods whose names promise a read.
 *
 * Listed rather than derived from the contract, because "is this a read" is a
 * judgement about intent that no schema records — and writing it down is what
 * makes a future method's classification a decision instead of an omission.
 */
const READS: { method: RpcMethod, params: (fixed: Fixture) => unknown }[] = [
  { method: 'chat.list', params: () => ({}) },
  { method: 'chat.open', params: fixed => ({ chatId: fixed.chatId }) },
  { method: 'prompt.itemize', params: fixed => ({ chatId: fixed.chatId }) },
  { method: 'script.context', params: fixed => ({ chatId: fixed.chatId, characterId: 'aria' }) },
  { method: 'script.context', params: fixed => ({ chatId: fixed.chatId, characterId: 'aria', messageId: 2 }) },
  { method: 'script.list', params: () => ({ characterId: 'aria' }) },
  { method: 'script.body', params: () => ({ characterId: 'aria', scriptId: 'panel' }) },
  { method: 'script.getVariables', params: fixed => ({ chatId: fixed.chatId, scope: 'chat' }) },
  { method: 'script.getVariables', params: fixed => ({ chatId: fixed.chatId, scope: 'message' }) },
  { method: 'script.getVariables', params: fixed => ({ chatId: fixed.chatId, scope: 'global' }) },
  { method: 'settings.get', params: fixed => ({ chatId: fixed.chatId }) },
  { method: 'connection.list', params: () => ({}) },
  { method: 'character.list', params: () => ({}) },
]

for (const { method, params } of READS) {
  test(`${method} leaves the conversation exactly as it found it`, async (t) => {
    const fixed = await fixture(t)
    const before = await snapshot(fixed)

    const call = fixed.handlers[method] as (input: unknown) => Promise<unknown>
    // A refusal is a legitimate outcome — `connection.list` refuses on a host
    // with no connection store — and it is still a read that must not have
    // written. Swallowing the error rather than configuring every store keeps
    // the subject the mutation, and it covers the worse case besides: a method
    // that writes and *then* fails still has to pass the comparison below.
    await call(params(fixed)).catch(() => undefined)

    const after = await snapshot(fixed)
    // Compared whole rather than field by field: the two escapes found so far
    // were both fields nobody thought to check — a preview writing chat
    // variables, and an assembly advancing world-info timing. A per-field
    // assertion only catches the fields its author already suspected.
    assert.equal(after, before, `${method} changed something about the conversation or the store`)
  })
}

test('the read list is not silently incomplete', async (t) => {
  // A read added to the contract and not to the list above would be unchecked,
  // and unchecked is indistinguishable from checked in a green suite. This
  // cannot prove the list complete — that is a judgement — but it fails when a
  // method named like a read is missing from it, which is the case that actually
  // happens.
  const { handlers } = await fixture(t)
  const readShaped = Object.keys(handlers).filter(name =>
    /^(?:.*\.(?:list|open|get|getVariables|body|context|itemize))$/u.test(name))
  const covered = new Set(READS.map(entry => entry.method as string))

  const missing = readShaped.filter(name => !covered.has(name))
  assert.deepEqual(
    missing,
    [],
    `these read-shaped methods are not checked for writes: ${missing.join(', ')}`,
  )
})
