import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { CharacterCard } from '@iris/character'

import { ChatEntry, createSession } from '../src/entry.ts'
import { seedGreeting } from '../src/chats.ts'

/**
 * What `chat.create` does to the greeting, and what it deliberately does not.
 *
 * Measured on the three cards added 2026-09-02: each one's stored floor 0 was
 * byte-identical to its card `first_mes` (17895 / 20 / 2 B), and the reading was
 * reported as "creation stores `first_mes` verbatim". That was too strong.
 * `chats.ts:455` maps every greeting through `expandMacros`, so the real rule is
 * **macros are expanded, regex scripts are not run** — and those three cards
 * agreed with the weaker claim only because none of their greetings contains a
 * macro. Byte-identity was a property of the sample, not of the path.
 *
 * The second half is what the reading view's behaviour rests on: one of those
 * cards stores an 8-character placeholder and renders to 9741, because the
 * expansion happens at render time. That premise lived only in prose
 * (`notes/TEST-CARDS.md` §七), and prose cannot notice when it stops being true.
 */

/** A card whose greeting carries both a macro and text a regex would rewrite. */
function card(first: string, regexes: unknown[] = []): CharacterCard {
  return {
    spec: 'chara_card_v3',
    spec_version: '3.0',
    data: {
      name: 'Aria',
      description: '',
      personality: '',
      scenario: '',
      first_mes: first,
      mes_example: '',
      creator_notes: '',
      system_prompt: '',
      post_history_instructions: '',
      alternate_greetings: [],
      tags: [],
      creator: '',
      character_version: '1',
      extensions: { regex_scripts: regexes },
    },
  } as CharacterCard
}

function seeded(first: string, regexes: unknown[] = []): string | undefined {
  const entry = new ChatEntry({
    chatId: 'aria-1',
    header: {
      user_name: 'Traveller', character_name: 'Aria',
      create_date: '2026-09-03 @10h00m00s', chat_metadata: {},
      iris: { chatId: 'aria-1', characterId: 'aria', title: 'Aria', updatedAt: 0 },
    },
    session: createSession('aria-1'),
    card: undefined,
  })
  seedGreeting(entry, card(first, regexes), { user: 'Traveller', char: 'Aria' })
  return entry.toView().messages[0]?.text
}

test('a macro in the greeting is expanded at creation', () => {
  // `{{user}}` surviving into storage would reach the model as a literal, and
  // the failure would surface three layers away as "the model ignored the
  // greeting" rather than as an unexpanded macro.
  const text = seeded('Hello, {{user}}. I am {{char}}.')
  assert.equal(text, 'Hello, Traveller. I am Aria.')
})

test('a regex script does not run at creation, even when it matches', () => {
  /*
   * The fixture has to be one the wrong implementation disagrees with: a card
   * whose regex would rewrite the greeting if creation applied it. A greeting no
   * regex matches passes under both implementations and pins nothing — the
   * mistake this repository has paid for repeatedly.
   *
   * So `PLACEHOLDER` is text the script below replaces. If creation ever starts
   * applying display regexes, this assertion is the one that says so.
   */
  const text = seeded('PLACEHOLDER', [{
    id: 'r1',
    scriptName: 'would rewrite the greeting',
    findRegex: '/PLACEHOLDER/g',
    replaceString: '<div>a whole status panel</div>',
    placement: [2],
    disabled: false,
    markdownOnly: true,
    promptOnly: false,
    runOnEdit: false,
    substituteRegex: 0,
  }])

  assert.equal(text, 'PLACEHOLDER',
    'creation applied a display regex; expansion belongs to the render path, and the reading view depends on it')
})

test('the greeting is stored unchanged when it has neither macro nor match', () => {
  // The three 2026-09-02 cards are all this case. Kept so the byte-identity
  // observation stays represented — but on its own it cannot tell the two rules
  // above apart, which is exactly why it was too weak a basis for the claim.
  assert.equal(seeded('Nothing to expand here.'), 'Nothing to expand here.')
})
