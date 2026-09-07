/**
 * The character page's arithmetic and its one-line sentences.
 *
 * These are the derivations the page makes over what the host sent, and they
 * live in a `.ts` module for one reason: the page is `.tsx`, Node's type
 * stripping does not transform JSX, and nothing in it can be imported here. So
 * the split is what makes these testable at all —
 * `character-page.test.ts` can only read the page's source, and
 * `tools/render-check.tsx` can only prove the whole tree renders.
 *
 * Every case below is a state the local corpus actually holds, and the figures
 * quoted are measured: 841 entries across the 11 book-carrying cards, 622
 * enabled, 309 constant, 307 with no keys at all, and **0 with secondary keys**.
 * That last zero is worth knowing while reading these: the secondary-key path is
 * the one the local library can never exercise, so it is held on the host side
 * (`worldbook-digest.test.ts`) where the mapping that produces the field lives,
 * rather than by a fixture here that would only be asserting itself.
 *
 * @module iris-web/tests/character-facts
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { CardBookDigest, ChatSummary, ScriptView, WorldbookEntryDigest } from '@iris/protocol'

import {
  bookFigures,
  chatsOf,
  describeBookOrigin,
  describeButtons,
  describePlace,
  describeScriptSwitch,
  describeTrigger,
  latestActivity,
} from '../src/app/character-facts.ts'

/** One entry, defaulted to the commonest shape in the corpus. */
function entry(over: Partial<WorldbookEntryDigest> = {}): WorldbookEntryDigest {
  return {
    uid: 0,
    name: 'an entry',
    enabled: true,
    constant: false,
    keys: ['ash'],
    position: 'before_character_definition',
    ...over,
  }
}

/** One book, defaulted to the card's own named book. */
function book(over: Partial<CardBookDigest> = {}): CardBookDigest {
  return { name: 'a book', source: 'named', role: 'card', entries: [], ...over }
}

/** One script row, defaulted to a script its author shipped switched on. */
function script(over: Partial<ScriptView> = {}): ScriptView {
  return { id: 's', name: 'a script', enabledByCard: true, enabled: true, bytes: 4_820, ...over }
}

/** One conversation summary. */
function chat(over: Partial<ChatSummary> = {}): ChatSummary {
  return { chatId: 'c', title: 'a chat', updatedAt: 1_000, messageCount: 3, ...over }
}

test('a book’s three figures are counted from the entries it was sent', () => {
  const figures = bookFigures(book({
    entries: [
      entry({ uid: 0 }),
      entry({ uid: 1, enabled: false }),
      entry({ uid: 2, constant: true }),
      entry({ uid: 3, constant: true, enabled: false }),
    ],
  }))

  // Counted rather than carried on the wire: a host-computed count beside the
  // rows it summarises is a second derivation, and the pair going out of step
  // is invisible.
  assert.deepEqual(figures, { entries: 4, enabled: 2, constant: 2 })
})

test('an empty book counts to zero rather than reading as an absent one', () => {
  assert.deepEqual(bookFigures(book()), { entries: 0, enabled: 0, constant: 0 })
})

test('a character’s conversations exclude everyone else’s, and the ownerless ones', () => {
  const chats = [
    chat({ chatId: 'mine-old', characterId: 'luoluo', updatedAt: 10 }),
    chat({ chatId: 'theirs', characterId: 'aria', updatedAt: 90 }),
    // `characterId` is optional on a `ChatSummary`. A chat with none is not
    // this character's, and an `undefined === undefined` match would put every
    // ownerless conversation on every card's page.
    chat({ chatId: 'nobody', updatedAt: 80 }),
    chat({ chatId: 'mine-new', characterId: 'luoluo', updatedAt: 50 }),
  ]

  assert.deepEqual(
    chatsOf(chats, 'luoluo').map(row => row.chatId),
    ['mine-new', 'mine-old'],
  )
  assert.deepEqual(chatsOf(chats, 'the-archivist'), [])
})

test('last activity is the newest of a card’s conversations, whatever order they arrive in', () => {
  const rows = [chat({ updatedAt: 10 }), chat({ updatedAt: 900 }), chat({ updatedAt: 400 })]
  assert.equal(latestActivity(rows), 900)
  // A card with no conversations has no last activity — not a zero, which would
  // render as 1970 through `since`.
  assert.equal(latestActivity([]), undefined)
})

test('a position is said in ST’s own terms, and only at_depth carries a depth', () => {
  assert.equal(describePlace(entry({ position: 'at_depth', depth: 7 }), 'en'), 'at depth 7')
  assert.equal(describePlace(entry({ position: 'at_depth', depth: 7 }), 'zh'), '深度 7')
  // 0 is a real depth — the newest floor — so it must not fall through to a
  // default.
  assert.equal(describePlace(entry({ position: 'at_depth', depth: 0 }), 'en'), 'at depth 0')
  assert.equal(describePlace(entry({ position: 'before_character_definition' }), 'zh'), '角色定义前')
  assert.equal(describePlace(entry({ position: 'outlet' }), 'en'), 'in an outlet')
})

test('the trigger says the keys, or says why there are none', () => {
  assert.equal(describeTrigger(entry({ keys: ['ash', 'ember'] }), 'en'), 'Keys: ash, ember')
  assert.equal(describeTrigger(entry({ keys: ['灰', '烬'] }), 'zh'), '触发键：灰、烬')
  // A constant entry needs no keys and the row's own 常驻 marker has already
  // said so — repeating it here would read as two facts.
  assert.equal(describeTrigger(entry({ keys: [], constant: true }), 'en'), undefined)
  // A *selective* entry with no keys can never fire. 307 of the corpus's 841
  // entries carry no keys, so this branch is not hypothetical, and nothing else
  // on the page would reveal it.
  assert.equal(describeTrigger(entry({ keys: [], constant: false }), 'en'), 'no keys — never fires')
  assert.equal(describeTrigger(entry({ keys: [], constant: false }), 'zh'), '没有触发键——永远不会触发')
})

test('a script’s two switches produce four sentences, not two', () => {
  // "Off" answers nothing a reader can act on: the author's choice is not
  // theirs to reverse, and their own is.
  assert.equal(describeScriptSwitch(script(), 'en'), 'enabled')
  assert.equal(
    describeScriptSwitch(script({ enabledByCard: true, enabled: false }), 'en'),
    'you switched it off',
  )
  assert.equal(
    describeScriptSwitch(script({ enabledByCard: false, enabled: false }), 'en'),
    'the author shipped it off',
  )
  assert.equal(
    describeScriptSwitch(script({ enabledByCard: false, enabled: true }), 'zh'),
    '你打开了',
  )
})

test('a script’s buttons report both numbers, and nothing when there are none', () => {
  assert.equal(describeButtons(script(), 'en'), undefined)
  assert.equal(describeButtons(script({ buttons: [] }), 'en'), undefined)
  // 58 of the corpus's 89 buttons are hidden by their author, so "3 buttons"
  // over a bar showing one is the ordinary case.
  assert.equal(
    describeButtons(script({
      buttons: [
        { name: 'a', visible: true },
        { name: 'b', visible: false },
        { name: 'c', visible: false },
      ],
    }), 'en'),
    '3 buttons, 1 shown',
  )
})

test('a book is annotated only when its origin needs explaining', () => {
  // The ordinary case: the card's own book, in a file, under its own name. A
  // row that annotates everything annotates nothing.
  assert.equal(describeBookOrigin(book(), 'en'), undefined)
  assert.equal(describeBookOrigin(book({ source: 'embedded' }), 'en'), 'in the card, not yet a file')
  assert.equal(describeBookOrigin(book({ materialised: true }), 'en'), 'renamed by this host')
  assert.equal(describeBookOrigin(book({ role: 'additional' }), 'zh'), '你自己绑上的')
  // Missing wins over every other note: a binding with nothing behind it is
  // the fact a reader needs first, whoever bound it.
  assert.equal(
    describeBookOrigin(book({ source: 'missing', role: 'additional' }), 'en'),
    'bound, but no such book here',
  )
})
