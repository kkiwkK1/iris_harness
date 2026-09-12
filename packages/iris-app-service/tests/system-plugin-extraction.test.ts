import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Context } from '@deepseek-ai/cordis'
import type { CharacterCard } from '@iris/character'
import { appendCandidate } from '@iris/chat'
import type { SillyTavernChatHeader } from '@iris/persistence'

import { seedGreeting, seedInitialVariables } from '../src/chats.ts'
import { ChatEntry, createSession } from '../src/entry.ts'
import { BUILTIN_SYSTEM_PLUGIN_DEFINITIONS } from '../src/plugins/builtins.ts'
import {
  MVU_CAPABILITY,
  type SystemPluginCapabilities,
} from '../src/plugins/capabilities.ts'
import { createMvuCapability, type MvuCapability } from '../src/plugins/mvu.ts'
import { SystemPluginRuntime } from '../src/system-plugins.ts'

/** A card with one declared MVU value and one greeting candidate. */
function card(): CharacterCard {
  return {
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      name: 'Aria',
      description: '', personality: '', scenario: '', first_mes: 'Hello.',
      mes_example: '', creator_notes: '', system_prompt: '',
      post_history_instructions: '', alternate_greetings: [], tags: [],
      creator: '', character_version: '1', extensions: {},
      character_book: {
        extensions: {},
        entries: [{
          keys: [], content: 'count: 0', comment: '[InitVar]', name: '[InitVar]',
          enabled: false, constant: false, insertion_order: 0, extensions: {},
        }],
      },
    },
  }
}

/** A real runtime backed by a test-local preference file. */
async function runtime(t: TestContext): Promise<SystemPluginRuntime> {
  const dir = await mkdtemp(join(tmpdir(), 'iris-plugin-extraction-'))
  const context = new Context()
  const plugins = new SystemPluginRuntime({
    context,
    file: join(dir, 'system-plugins.json'),
    definitions: BUILTIN_SYSTEM_PLUGIN_DEFINITIONS,
  })
  await plugins.initialize()
  t.after(async () => {
    await plugins.dispose()
    await rm(dir, { recursive: true, force: true })
  })
  return plugins
}

/** A live chat bound to the supplied runtime. */
function entry(plugins?: SystemPluginCapabilities): ChatEntry {
  const header: SillyTavernChatHeader = {
    user_name: 'Traveller',
    character_name: 'Aria',
    create_date: '2026-09-12 @10h00m00s',
    chat_metadata: {},
    iris: { chatId: 'aria-1', characterId: 'aria', title: 'Aria', updatedAt: 0 },
  }
  const value = new ChatEntry({
    chatId: 'aria-1',
    header,
    session: createSession('aria-1'),
    card: card(),
    ...plugins === undefined ? {} : { plugins },
  })
  seedGreeting(value, value.card!, { user: 'Traveller', char: 'Aria' })
  return value
}

/** Add one settled user/reply pair so MVU has a candidate to attach to. */
function appendTurn(value: ChatEntry, turn: number, reply: string): void {
  value.session.append('turn/start', { turn })
  value.session.append('step/start', { turn, step: 0 })
  value.session.append(
    'user/message',
    createUserMessage({ content: [{ type: 'text', text: `Question ${String(turn)}` }], source: { kind: 'user' } }),
    { surfaceOp: 'append' },
  )
  appendCandidate(value.session, {
    turn,
    step: 0,
    message: createAssistantMessage({
      content: [{ type: 'text', text: reply }],
      source: { provider: 'test', model: 'test' },
    }),
  })
  value.session.append('step/end', { turn, step: 0 })
  value.session.append('turn/end', { turn, reason: { kind: 'completed' } })
}

/** Read the state attached to a turn. */
function countAt(value: ChatEntry, turn: number): number | undefined {
  const variables = value.variables.getVariables({ type: 'message', message_id: turn })
  return (variables['stat_data'] as Record<string, unknown> | undefined)?.['count'] as number | undefined
}

test('MVU enable-disable-enable preserves state and skips disabled history', async (t) => {
  const plugins = await runtime(t)
  const chat = entry(plugins)
  seedInitialVariables(chat)

  chat.recordVariables(0, "<UpdateVariable>_.add('count', 1);</UpdateVariable>")
  assert.equal(countAt(chat, 0), 1)

  await plugins.disable('mvu')
  const before = chat.session.events.filter(event => event.type === 'iris/variables').length
  const disabledReply = "<UpdateVariable>_.set('count', 99);</UpdateVariable>"
  appendTurn(chat, 1, disabledReply)
  chat.recordVariables(1, disabledReply)

  assert.equal(
    chat.session.events.filter(event => event.type === 'iris/variables').length,
    before,
    'disabled MVU appended a variable mutation',
  )
  assert.equal(countAt(chat, 0), 1, 'disabling MVU altered the persisted baseline')

  await plugins.enable('mvu')
  const enabledReply = "<UpdateVariable>_.add('count', 1);</UpdateVariable>"
  appendTurn(chat, 2, enabledReply)
  chat.recordVariables(2, enabledReply)

  assert.equal(
    countAt(chat, 2),
    2,
    're-enable replayed the disabled turn or failed to resume from the latest persisted baseline',
  )
})

test('disabled MVU does not seed a new chat and re-enable computes from declarations once', async (t) => {
  const plugins = await runtime(t)
  await plugins.disable('mvu')
  const chat = entry(plugins)

  seedInitialVariables(chat)
  assert.equal(
    chat.session.events.some(event => event.type === 'iris/variables'),
    false,
    'a disabled capability initialized stored variables',
  )

  await plugins.enable('mvu')
  chat.recordVariables(0, "<UpdateVariable>_.add('count', 1);</UpdateVariable>")
  assert.equal(countAt(chat, 0), 1)
})

test('Tavern Helper macro expansion follows the live capability in an open chat', async (t) => {
  const plugins = await runtime(t)
  const chat = entry(plugins)
  seedInitialVariables(chat)
  const macro = '{{get_message_variable::stat_data.count}}'

  assert.equal(chat.substitute(macro), '0')

  await plugins.disable('mvu')
  await plugins.disable('tavern-helper')
  assert.equal(chat.substitute(macro), macro, 'a disposed macro capability still expanded text')

  await plugins.enable('tavern-helper')
  assert.equal(chat.substitute(macro), '0', 'the open chat retained the disposed capability instance')
})

test('MVU drops a computed update when its capability is replaced before commit', () => {
  const replacement = createMvuCapability(12)
  let current: MvuCapability | undefined
  const stale: MvuCapability = {
    revision: 11,
    initialState: replacement.initialState,
    replay: replacement.replay,
    update(_text, baseline) {
      current = replacement
      return {
        data: { ...baseline, stat_data: { ...baseline.stat_data, count: 99 } },
        reports: [],
      }
    },
  }
  current = stale
  const plugins: SystemPluginCapabilities = {
    snapshot: () => ({ revision: current?.revision ?? 12 }),
    capability<T>(pluginId: string, name: string): T | undefined {
      if (pluginId !== 'mvu' || name !== MVU_CAPABILITY) return undefined
      return current as T | undefined
    },
  }
  const chat = entry(plugins)
  seedInitialVariables(chat)
  const before = chat.session.events.filter(event => event.type === 'iris/variables').length

  const returned = chat.recordVariables(0, "<UpdateVariable>_.set('count', 99);</UpdateVariable>")

  assert.equal((returned.stat_data as Record<string, unknown>)['count'], 0)
  assert.equal(countAt(chat, 0), 0)
  assert.equal(
    chat.session.events.filter(event => event.type === 'iris/variables').length,
    before,
    'a disposed MVU incarnation committed its computed state',
  )
})

test('an absent plugin runtime keeps compatibility MVU while an explicit disabled execution does not', () => {
  const compatible = entry()
  seedInitialVariables(compatible)
  compatible.recordVariables(0, "<UpdateVariable>_.add('count', 1);</UpdateVariable>")
  assert.equal(countAt(compatible, 0), 1)

  const disabled = entry()
  seedInitialVariables(disabled)
  disabled.recordVariables(
    0,
    "<UpdateVariable>_.add('count', 1);</UpdateVariable>",
    undefined,
    null,
  )
  assert.equal(countAt(disabled, 0), 0)
})
