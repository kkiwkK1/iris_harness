/**
 * Why a card's MagVarUpdate no longer raises its own variable-cleanup offer.
 *
 * Iris ports that path natively — the host asks on `chat.open`, sweeps the chat
 * file and exports a real backup (`app/CleanupOffer.tsx`,
 * `packages/iris-app-service/src/prune.ts`, `notes/apps/iris-web/DEVIATIONS.md`
 * 17) — and until this landed, MVU's in-frame copy was running in parallel. It
 * only *looked* fine because the popup API was missing: reading
 * `SillyTavern.POPUP_TYPE.CONFIRM` threw, and the crash hid the double-ask.
 *
 * So the gate is closed with upstream's own fourth condition. The assertions
 * below are written **as MVU's own bundle writes them** — the same `_.has`
 * calls on the same paths, from `artifact/bundle.js` read 2026-09-08 — because
 * a hand-rolled `hasOwnProperty` check would be a second opinion about the
 * predicate rather than the predicate.
 *
 * @module iris-web/tests/legacy-cleanup-seal
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

// `has` by name, not the default bag: `lodash-es` has no default export, and
// this is the one function the transcribed predicate below uses.
import { has } from 'lodash-es'

import {
  IGNORE_CLEANUP_KEY,
  restoreFloorTables,
  sealLegacyCleanup,
} from '../src/sandbox/tavern-helper.ts'

/** A floor as the snapshot carries it: `variables` is JSON text. */
function floor(text?: string): Record<string, unknown> {
  return {
    mes: 'x',
    is_user: false,
    swipes: ['x'],
    swipe_id: 0,
    ...(text === undefined ? {} : { variables: text }),
  }
}

/** A chat long enough to pass MVU's length gate, with tables on floor 1. */
function chatOf(firstFloorTables: unknown = [{ stat_data: { 好感度: 32 }, schema: {} }]): Record<string, unknown>[] {
  const chat = [floor(), floor(JSON.stringify(firstFloorTables))]
  while (chat.length < 26) chat.push(floor())
  return chat
}

/**
 * MVU's four gates, transcribed from its bundle.
 *
 * `!e.settings.自动清理变量.启用 || SillyTavern.chat.length <= keep + 5
 *  || !_.has(SillyTavern.chat, [1,'variables',0,'stat_data'])
 *  || _.has(SillyTavern.chat, [1,'variables',0,'ignore_cleanup'])`
 * — and a `true` here is the `return` that never reaches `callGenericPopup`.
 * @param chat - the frame's chat snapshot.
 * @returns whether MVU stands down.
 */
function mvuStandsDown(chat: readonly unknown[]): boolean {
  const keep = 20
  return (
    chat.length <= keep + 5
    || !has(chat, [1, 'variables', 0, 'stat_data'])
    || has(chat, [1, 'variables', 0, 'ignore_cleanup'])
  )
}

test('without the seal, MVU’s own gates open on a 26-message chat', () => {
  /*
   * The control, and the test is worth nothing without it: this is the state
   * the user hit on 2026-09-08. If this ever reads `true`, the seal below is
   * proving nothing because the gates were shut anyway.
   */
  const chat = chatOf()
  restoreFloorTables(chat as never)
  assert.equal(mvuStandsDown(chat), false, 'the gates were already shut, so nothing below discriminates')
})

test('the seal closes MVU’s fourth gate, and only the fourth', () => {
  const chat = chatOf()
  restoreFloorTables(chat as never)
  sealLegacyCleanup(chat as never)

  assert.equal(mvuStandsDown(chat), true, 'MVU still reaches its own popup')
  assert.equal(has(chat, [1, 'variables', 0, IGNORE_CLEANUP_KEY]), true)
  /*
   * **Gate three is deliberately left open.** `stat_data` on floor 1 is real
   * data and MVU's restore path replays from it; hiding it to close the offer
   * would break restoring to buy silence. The host's own gates read the chat
   * file, not this snapshot, so its offer still fires.
   */
  assert.equal(has(chat, [1, 'variables', 0, 'stat_data']), true, 'the restore path lost its snapshot')
})

test('the mark cannot be written back into the chat file', () => {
  /*
   * The hazard this defends against, and it is not hypothetical: MVU's restore
   * path writes floors from `snapshot + 1` upward through
   * `updateVariablesWith({type:'message', message_id})`, and that lower bound
   * can be floor 1. An enumerable mark would ride that write into the real
   * file and silently disable the host's offer for that chat forever — the
   * user losing a feature with nothing on screen to say so.
   *
   * Four escape routes, because a card can take any of them: serialization,
   * spread, key enumeration, and the structured clone a `postMessage` performs.
   */
  const chat = chatOf()
  restoreFloorTables(chat as never)
  sealLegacyCleanup(chat as never)
  const tables = chat[1]?.['variables'] as Record<string, unknown>[]
  const table = tables[0] as Record<string, unknown>

  assert.equal(JSON.stringify(table).includes(IGNORE_CLEANUP_KEY), false, 'JSON carried it')
  assert.equal(Object.keys(table).includes(IGNORE_CLEANUP_KEY), false, 'enumeration carried it')
  assert.equal(IGNORE_CLEANUP_KEY in { ...table }, false, 'a spread copy carried it')
  assert.equal(IGNORE_CLEANUP_KEY in structuredClone(table), false, 'a postMessage would carry it')
  // And it is still there on the object itself, which is the whole point.
  assert.equal(Object.prototype.hasOwnProperty.call(table, IGNORE_CLEANUP_KEY), true)
})

test('a refusal the user really recorded is left exactly as it is', () => {
  /*
   * A chat carried over from SillyTavern can hold upstream's own key, because
   * someone pressed "do not remind me again" there. Redefining it would be a
   * write over the user's real answer — and it would also make a durable,
   * enumerable value non-enumerable, which is a data change disguised as a
   * mark.
   */
  const chat = chatOf([{ stat_data: {}, ignore_cleanup: true }])
  restoreFloorTables(chat as never)
  sealLegacyCleanup(chat as never)
  const table = (chat[1]?.['variables'] as Record<string, unknown>[])[0] as Record<string, unknown>
  assert.equal(Object.keys(table).includes(IGNORE_CLEANUP_KEY), true, 'the user’s own answer stopped persisting')
  assert.equal(JSON.parse(JSON.stringify(table))[IGNORE_CLEANUP_KEY], true)
})

test('a chat with nothing to seal is left alone rather than invented into', () => {
  // Each of these is a real snapshot: a brand-new chat, a chat whose floor 1
  // has no tables, and one whose tables are an empty array. None of them passes
  // MVU's third gate either, so there is nothing to close.
  for (const chat of [[], [floor()], [floor(), floor()], [floor(), floor('[]')]]) {
    restoreFloorTables(chat as never)
    sealLegacyCleanup(chat as never)
    assert.equal(mvuStandsDown(chat), true)
  }
})
