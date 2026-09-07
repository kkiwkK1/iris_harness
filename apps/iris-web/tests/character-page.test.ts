/**
 * The character page's fact columns, and the rules about what is absent.
 *
 * **These are source assertions, and that is a compromise with a reason.** The
 * page is a `.tsx` module and Node's type stripping does not transform JSX, so
 * no `node --test` file can import and render it; the project's one real render
 * harness is `tools/render-check.tsx`, which mounts the whole App. So what is
 * checked here is that the page's *structure* still encodes the decisions —
 * every column guarded by the field it reports, the zero case given its own
 * sentence, the consent answer read together with the card it was given about.
 * A test like this cannot see layout, and it is not evidence that the page
 * renders; it is evidence that a guard was not deleted.
 *
 * The copy half is checked properly: the keys the page names must exist in both
 * dictionaries, and the keys it stopped naming must be gone from them, because
 * unused copy is copy that gets translated, reviewed and maintained for nobody.
 *
 * @module iris-web/tests/character-page
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { DICTIONARIES, en, type StringKey } from '../src/app/i18n/strings.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const PAGE = readFileSync(join(HERE, '..', 'src', 'app', 'CharacterPage.tsx'), 'utf8')

/** The keys the page renders, in the order it renders them. */
const KEYS: readonly StringKey[] = [
  'characterPageAria',
  'facePickHint',
  'faceCreator',
  'startNewChat',
  'faceDescription',
  'faceConversations',
  'faceNoConversations',
  'faceOneConversation',
  'faceOpenCount',
  'faceLatest',
  'faceWorldbook',
  'faceBookEntries',
  'faceBookEmpty',
  'faceScripts',
  'faceScriptCount',
  'faceScriptsAllowed',
  'faceScriptsDeclined',
]

test('the page names every key it needs, in both languages', () => {
  for (const key of KEYS) {
    assert.match(PAGE, new RegExp(`t\\('${key}'`), `the page no longer renders ${key}`)
    assert.ok(key in en, `${key} is not in the dictionary`)
    assert.ok(DICTIONARIES.zh[key].length > 0, `${key} has no Chinese`)
  }
})

test('the copy the page stopped showing is gone from both dictionaries', () => {
  /*
   * 标签 and 卡片文件 were stand-ins: the page showed them while
   * `CharacterSummary` carried nothing about a card's contents, and the
   * artboards' own columns (对话 / 世界书 / 脚本) could not be filled. Their
   * strings are deleted rather than left in place, because a dictionary entry
   * nothing renders is still a row a translator has to answer for — and the
   * tags are already on the page as capsules under the name.
   */
  const retired = ['faceTags', 'faceNoTags', 'faceTagCount', 'faceCardFile', 'faceUpdated', 'faceUpdatedUnknown']
  for (const key of retired) {
    assert.equal(key in en, false, `${key} is unused copy still in the en dictionary`)
    assert.equal(key in DICTIONARIES.zh, false, `${key} is unused copy still in the zh dictionary`)
    assert.ok(!PAGE.includes(key), `${key} is back on the page; give it a column and a dictionary entry`)
  }
})

test('each content column is guarded by the field it reports', () => {
  /*
   * Absence is the common case, not the edge: measured over the 19 local cards,
   * 15 carry no description, 2 embed no book and 5 carry no scripts. A column
   * rendered unconditionally would print a heading over nothing for most of a
   * real library, which is exactly what `没有的数据不编` forbids.
   */
  assert.match(
    PAGE,
    /character\.description === undefined \|\| character\.description === ''/,
    'the description column no longer refuses an absent or empty description',
  )
  assert.match(
    PAGE,
    /character\.bookEntryCount === undefined \? null/,
    'the world book column is no longer guarded on the count being present',
  )
  assert.match(
    PAGE,
    /character\.scriptCount === undefined \? null/,
    'the script column is no longer guarded on the count being present',
  )
})

test('an embedded empty book gets its own sentence, not a count of zero', () => {
  // The protocol keeps "no book" and "an empty book" apart on purpose; a page
  // that rendered the second as 「内嵌 0 条」 would throw away the distinction
  // it was sent.
  assert.match(
    PAGE,
    /character\.bookEntryCount === 0[\s\S]{0,80}faceBookEmpty/,
    'the zero case is no longer distinguished from a non-empty book',
  )
})

test('the consent answer is read together with the card it was given about', () => {
  /*
   * `scriptsAllowed` describes whichever card `scriptsFor` names. Reading it
   * alone on a page about a *different* character would report one card's
   * decision as another's — the same fault the store clears the field for when
   * a chat opens, and one that shows nothing wrong on screen.
   *
   * And the two answered states are named positively. A deny-list of
   * `unknown` / `unasked` would give any state added to `ConsentState` later the
   * "reported" branch by default, on a line that reports a permission.
   */
  assert.match(PAGE, /state\.scriptsFor/, 'the page no longer reads which card the consent answer is about')
  assert.match(
    PAGE,
    /scriptsFor === character\.characterId/,
    'the consent answer is no longer scoped to this character',
  )
  assert.match(
    PAGE,
    /scriptsAllowed === 'allowed' \|\| scriptsAllowed === 'declined'/,
    'the answered states are no longer named as an allow-list',
  )
  for (const state of ['unknown', 'unasked']) {
    assert.ok(
      !PAGE.includes(`scriptsAllowed === '${state}'`),
      `${state} is being tested for; the allow-list above already excludes it`,
    )
  }
})

test('the facts row still has a column that is always knowable', () => {
  /*
   * The conversation count is derived from `state.chats` and is therefore
   * answerable for every card, zero included. It is what keeps a plain V1 card
   * — no description, no book, no scripts, which is a real shape — from
   * rendering a facts row with nothing in it, and it is one of the artboards'
   * own three columns.
   */
  assert.match(PAGE, /t\('faceConversations'\)/, 'the always-knowable column is gone')
  assert.match(PAGE, /chats\.filter\(row => row\.characterId === character\.characterId\)/, 'the count is no longer derived')
})
