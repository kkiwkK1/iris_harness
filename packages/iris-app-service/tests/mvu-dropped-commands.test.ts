import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { CharacterCard } from '@iris/character'
import type { SillyTavernChatHeader } from '@iris/persistence'

import { seedGreeting } from '../src/chats.ts'
import { ChatEntry, createSession } from '../src/entry.ts'
import type { ResolvedWorldbook } from '../src/worldbooks.ts'

/**
 * A reply that asked for an update nobody could read says so.
 *
 * The JSON Patch dialect went unread for a whole release because a reply
 * carrying commands and a reply carrying none produced the same silence. That
 * hole was closed on the patch side and left open on the legacy side, where
 * {@link extractCommands} still drops a malformed call without a word — correct
 * behaviour, since upstream drops it too, and a useless signal.
 *
 * The distinction matters at exactly one moment: someone is looking at an
 * unchanged variable table and has to decide whether the model wrote no
 * command or whether we failed to read one. Without a line here, the two are
 * indistinguishable, and the wrong half of the system gets debugged.
 */

/** A card whose data is enough to open a chat with. */
function card(): CharacterCard {
  return {
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      name: 'Aria',
      description: '', personality: '', scenario: '',
      first_mes: 'Hello.', mes_example: '', creator_notes: '',
      system_prompt: '', post_history_instructions: '',
      alternate_greetings: [], tags: [], creator: '',
      character_version: '1', extensions: {},
    },
  }
}

/** An open conversation with one greeting on it. */
function entry(): ChatEntry {
  const header: SillyTavernChatHeader = {
    user_name: 'Traveller',
    character_name: 'Aria',
    create_date: '2026-09-01 @10h00m00s',
    chat_metadata: {},
    iris: { chatId: 'aria-1', characterId: 'aria', title: 'Aria', updatedAt: 0 },
  }
  const built = new ChatEntry({
    chatId: 'aria-1', header, session: createSession('aria-1'), card: card(),
    // The declared starting tree, because MVU refuses `set` on a path that
    // does not exist — the same reason a real card ships one.
    worldbook: {
      source: 'embedded',
      world: 'aria-book',
      global: [],
      entries: [{ comment: '[InitVar]', content: '{"a": 0, "b": 0, "c": 0, "mood": "flat"}' }],
    } as unknown as ResolvedWorldbook,
  })
  seedGreeting(built, card(), { user: 'Traveller', char: 'Aria' })
  return built
}

/**
 * Fold a reply and collect whatever it reported.
 *
 * The chat starts from the card`s declared tree, because MVU refuses `set` on a
 * path that does not exist — without one, every command fails for that reason
 * and the reports under test are buried under noise no real chat produces.
 */
function fold(text: string): { reports: string[], data: Record<string, unknown> } {
  const reports: string[] = []
  const data = entry().recordVariables(0, text, message => reports.push(message))
  return { reports, data: data as unknown as Record<string, unknown> }
}

test('a legacy call that could not be read is reported, not dropped in silence', () => {
  // Missing the terminating semicolon: upstream's extractor walks past it, and
  // so does ours. The update the model asked for is gone either way — the only
  // question is whether anyone is told.
  const { reports } = fold("<UpdateVariable>_.set('mood', 'calm')</UpdateVariable>")

  assert.equal(reports.length, 1, `expected one report, got ${JSON.stringify(reports)}`)
  assert.match(reports[0] ?? '', /1 _\.verb\(\) call\(s\) and 1 could not be read/u)
})

test('a partly-read reply reports the drop, because a lost update is still lost', () => {
  const { reports, data } = fold(
    "<UpdateVariable>_.set('a', 1);\n_.set('b', 2)\n_.set('c', 3);</UpdateVariable>",
  )

  // Two of three understood. Upstream keeps those two and says nothing about
  // the third; we keep the two and name the third.
  const stat = data['stat_data'] as Record<string, unknown> | undefined
  assert.equal(stat?.['a'], 1)
  assert.equal(stat?.['c'], 3)
  assert.equal(stat?.['b'], 0, 'the unreadable call must not land')
  assert.equal(reports.length, 1)
  assert.match(reports[0] ?? '', /3 _\.verb\(\) call\(s\) and 1 could not be read/u)
})

test('a reply whose calls were all understood reports nothing', () => {
  // The guard has to stay quiet on the ordinary case, or the line it writes
  // stops being read at all.
  const { reports } = fold("<UpdateVariable>_.set('mood', 'calm');</UpdateVariable>")
  assert.deepEqual(reports, [])
})

test('a reply with no update block at all reports nothing', () => {
  // The other half of the distinction: this is the silence that is *supposed*
  // to mean "the model did not ask for anything".
  assert.deepEqual(fold('Just prose, no commands.').reports, [])
})
