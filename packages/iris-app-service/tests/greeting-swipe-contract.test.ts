import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import type { CharacterCard } from '@iris/character'
import { createTavernHelper, type ChatMessageSwiped, type GetChatMessagesOptions } from '@iris/compat-tavernhelper'
import { memoryBackend, sessionMessageBackend, VariableStore } from '@iris/variables'

import { seedGreeting } from '../src/chats.ts'
import { ChatEntry, createSession } from '../src/entry.ts'

/**
 * The greeting-swipe contract, pinned on a real card's data.
 *
 * 人贩子物语's opener (its `first_mes`, committed verbatim as the fixture) draws
 * four buttons — `jumpGreeting(1)` through `jumpGreeting(4)` — and the handler
 * inside the same page reads the swipes off floor 0:
 *
 * ```js
 * var messages = await getChatMessages('0', { include_swipe: true });
 * var msg = messages && messages[0];
 * if (!msg || !msg.swipes || !msg.swipes[swipeId]) {
 *   alert('开场白 ' + swipeId + ' 不存在，请确认卡片已导入完整开场白。');
 * ```
 *
 * Two facts about that call: the option is **misspelled** (`include_swipe`),
 * which upstream's own destructuring ignores too, and the swipes are read from
 * the plain shape anyway — upstream carries `swipe_id`/`swipes`/`swipes_data` on
 * every shape under its `// for compatibility` comment
 * (`JS-Slash-Runner/src/function/chat_message.ts:139-143`). The stored file and
 * the session log always had all five texts; the surface that stripped them was
 * the only thing missing. Each fixture text below is asserted **verbatim**
 * (none contains a macro, so `seedGreeting`'s `expandMacros` pass is the
 * identity on them), and the misspelled option is passed exactly as the card
 * writes it, so this test fails the day either half of the contract drifts.
 */

interface GreetingFixture {
  card: string
  first_mes: string
  alternate_greetings: string[]
}

const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/人贩子物语-greetings.json', import.meta.url), 'utf8'),
) as GreetingFixture

const NAMES = { user: '旅人', char: '人贩子物语' }

function cardFrom(fixture: GreetingFixture): CharacterCard {
  return {
    spec: 'chara_card_v3',
    spec_version: '3.0',
    data: {
      name: fixture.card,
      description: '',
      personality: '',
      scenario: '',
      first_mes: fixture.first_mes,
      mes_example: '',
      creator_notes: '',
      system_prompt: '',
      post_history_instructions: '',
      alternate_greetings: fixture.alternate_greetings,
      tags: [],
      creator: '',
      character_version: '1',
      extensions: {},
    },
  } as CharacterCard
}

function imported(): { entry: ChatEntry, helper: ReturnType<typeof createTavernHelper> } {
  const entry = new ChatEntry({
    chatId: 'renfanzi-1',
    header: {
      user_name: NAMES.user, character_name: fixture.card,
      create_date: '2026-09-08 @10h00m00s', chat_metadata: {},
      iris: { chatId: 'renfanzi-1', characterId: 'renfanzi', title: fixture.card, updatedAt: 0 },
    },
    session: createSession('renfanzi-1'),
    card: undefined,
  })
  seedGreeting(entry, cardFrom(fixture), NAMES)
  const variables = new VariableStore({
    message: sessionMessageBackend(entry.session),
    chat: memoryBackend(),
    global: memoryBackend(),
    script: memoryBackend(),
  })
  const helper = createTavernHelper({ session: entry.session, variables, names: { user: NAMES.user, character: fixture.card } })
  return { entry, helper }
}

test('the import lands every greeting as a floor-0 swipe candidate', () => {
  const { entry } = imported()
  const swipes = entry.toFile().messages[0]?.swipes

  // first_mes plus the four alternates: the card ships five texts, floor 0
  // holds five candidates, and `selectCandidate(session, 0, 0)` shows first_mes.
  assert.equal(swipes?.length, 5)
  assert.deepEqual(swipes, [fixture.first_mes, ...fixture.alternate_greetings])
})

test(`the card's own read — misspelled option and all — sees the swipes`, () => {
  const { helper } = imported()
  const get = helper.api.getChatMessages as (
    range: string | number,
    options?: object,
  ) => ChatMessageSwiped[]

  // `include_swipe`, exactly as the card writes it. Upstream ignores the
  // unknown key and answers from the compatibility fields; so must this.
  const messages = get('0', { include_swipe: true } as unknown as GetChatMessagesOptions)
  assert.equal(messages.length, 1, 'floor 0 exists')
  assert.equal(messages[0]?.swipe_id, 0)
  assert.deepEqual(messages[0]?.swipes, [fixture.first_mes, ...fixture.alternate_greetings])

  // The guard the card runs next: `msg.swipes[swipeId]` for each button,
  // 1 through 4. Under the stripped shape every one of these was undefined,
  // which is the "开场白 N 不存在" alert three of them produced.
  for (const swipeId of [1, 2, 3, 4]) {
    assert.equal(messages[0]?.swipes[swipeId], fixture.alternate_greetings[swipeId - 1],
      `开场白 ${swipeId} 存在，jumpGreeting(${swipeId}) 能切过去`)
  }
})
