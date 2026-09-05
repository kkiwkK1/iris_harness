import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { computeBudget, type LorebookEntry } from '@iris/lorebook'

import type { ChatLoreBook } from '../src/prompt.ts'
import { scanEntriesOf } from '../src/prompt.ts'
import type { ResolvedWorldbook } from '../src/worldbooks.ts'
import { readTimedEffects, writeTimedEffects } from '../src/entry.ts'

/**
 * The chat-bound book and the scan's source ordering.
 *
 * `chat_metadata.world_info` holds a book **name**, and upstream loads it fresh
 * at every scan (`getChatLore`, `world-info.js:4430`), prepending it ahead of
 * the strategy ordering — its own comment: "Chat lore always goes first, then
 * persona lore, then the rest" (`world-info.js:4512`). This is the one body of
 * world info a card writes *during play*, so a resolution taken at chat-open
 * time never sees what the card added.
 *
 * The ordering tests transcribe `getSortedEntries` (`world-info.js:4478`)
 * case by case, because order decides who reaches the budget first and breaks
 * activation ties — it is behaviour, not presentation.
 */

const entry = (uid: number, comment: string, extra: Partial<LorebookEntry> = {}): LorebookEntry => ({
  uid, key: [], keysecondary: [], comment, content: `${comment} body`,
  constant: false, selective: true, vectorized: false, selectiveLogic: 0,
  order: 100, position: 4, disable: false, displayIndex: uid, ...extra,
}) as LorebookEntry

const resolved = (partial: Partial<ResolvedWorldbook>): ResolvedWorldbook => ({
  entries: [], source: 'none', world: 'nobody', additional: [], global: [], ...partial,
})

const comments = (entries: { comment: string }[]): string[] => entries.map(entry => entry.comment)

// ------------------------------------------------------------------ chat lore

test('the chat book is scanned first, ahead of every other source', () => {
  const chat: ChatLoreBook[] = [{ world: 'Chat Book', entries: [entry(0, 'chat entry')] }]
  const chosen = resolved({
    entries: [entry(1, 'own entry')],
    global: [{ world: 'Global', entries: [entry(2, 'global entry')] }],
  })

  // `character_first` would put the character before the global, and both before
  // nothing else — the chat book precedes them all, unconditionally.
  assert.deepEqual(
    comments(scanEntriesOf(undefined, chosen, chat, 'character_first')),
    ['chat entry', 'own entry', 'global entry'],
  )
})

test('a chat book that is globally selected is skipped — global wins that overlap', () => {
  // Upstream's guard in `getChatLore`: `selected_world_info.includes(chatWorld)`
  // yields no entries. The chat book is the loser of this overlap by design,
  // because the global selection is the more deliberate act of the two.
  const chat: ChatLoreBook[] = [{ world: 'Shared', entries: [entry(0, 'chat entry')] }]
  const chosen = resolved({
    entries: [entry(1, 'own entry')],
    global: [{ world: 'Shared', entries: [entry(2, 'shared entry')] }],
  })

  const scanned = scanEntriesOf(undefined, chosen, chat, 'character_first')
  assert.deepEqual(comments(scanned), ['own entry', 'shared entry'])
})

// ------------------------------------------------------------------ ordering

const globalBook = (name: string, comments_: string[], order = 100): ResolvedWorldbook['global'][number] => ({
  world: name,
  entries: comments_.map((comment, index) => entry(index, comment, { order })),
})

test('character_first sorts each group separately: order does not interleave sources', () => {
  // A global entry weighted ABOVE the character's still comes after every
  // character entry. The one-blended-sort this replaces interleaved them, which
  // is neither `character_first` nor `evenly` — it was a third strategy no
  // upstream value produces.
  const chosen = resolved({
    entries: [entry(0, 'own low', { order: 10 })],
    global: [globalBook('G', ['global high', 'global mid'])],
  })
  chosen.global[0]!.entries[1]!.order = 50

  assert.deepEqual(
    comments(scanEntriesOf(undefined, chosen, [], 'character_first')),
    // Descending order within each group, and the whole character group first
    // — even though both global entries outweigh it.
    ['own low', 'global high', 'global mid'],
  )
})

test('global_first is the mirror image', () => {
  const chosen = resolved({
    entries: [entry(0, 'own high', { order: 300 })],
    global: [globalBook('G', ['global low'], 10)],
  })

  // The character entry weighs thirty times more; `global_first` still puts the
  // global entry ahead of it.
  assert.deepEqual(
    comments(scanEntriesOf(undefined, chosen, [], 'global_first')),
    ['global low', 'own high'],
  )
})

test('evenly sorts the concatenation, where ties go to the globally selected', () => {
  // Upstream: `[...globalLore, ...characterLore].sort(sortFn)` — the global book
  // is concatenated first, so a stable sort keeps it ahead of a character entry
  // with the same order.
  const chosen = resolved({
    entries: [entry(0, 'own entry')],
    global: [globalBook('G', ['global entry'])],
  })

  assert.deepEqual(
    comments(scanEntriesOf(undefined, chosen, [], 'evenly')),
    ['global entry', 'own entry'],
  )
})

test('a character book that is the chat book is dropped from the character side', () => {
  // Upstream's guard in `getCharacterLore`: a world equal to
  // `chat_metadata[METADATA_KEY]` is skipped ("already activated in chat lore").
  // Without it, the chat book's fresh copy doubles the character's entries.
  const chat: ChatLoreBook[] = [{ world: 'Same', entries: [entry(0, 'chat copy')] }]
  const chosen = resolved({
    entries: [entry(1, 'own entry')],
    world: 'Same',
    source: 'named',
  })

  assert.deepEqual(
    comments(scanEntriesOf(undefined, chosen, chat, 'character_first')),
    ['chat copy'],
  )
})

// -------------------------------------------------------------- timed effects

test('timed windows round-trip through the chat metadata block', () => {
  const metadata: Record<string, unknown> = {}
  const state = {
    sticky: { 'MyBook.3': { hash: 42, start: 4, end: 9, protected: false } },
    cooldown: { 'MyBook.7': { hash: 7, start: 4, end: 6, protected: true } },
  }

  writeTimedEffects(metadata, state)
  // The same key upstream uses, under the same shape — a card reading
  // `chatMetadata.timedWorldInfo` from its snapshot sees what upstream's would
  // have shown it.
  assert.deepEqual(metadata['timedWorldInfo'], state)
  assert.deepEqual(readTimedEffects(metadata), state)
})

test('a metadata block with no windows reads as none, not as an empty table', () => {
  assert.equal(readTimedEffects({}), undefined)
  assert.equal(readTimedEffects({ timedWorldInfo: {} }), undefined)
})

test('a malformed window is dropped rather than read', () => {
  // The engine does arithmetic on `start` and `end`; a window carrying a string
  // would poison a comparison instead of throwing. Upstream's own reader deletes
  // entries it does not recognise; this refuses them at the read.
  const restored = readTimedEffects({
    timedWorldInfo: {
      sticky: { 'Book.1': { hash: 1, start: 'three', end: 4, protected: false } },
      cooldown: { 'Book.2': { hash: 2, start: 0, end: 5, protected: true } },
    },
  })

  assert.deepEqual(restored, {
    sticky: {},
    cooldown: { 'Book.2': { hash: 2, start: 0, end: 5, protected: true } },
  })
})

// ------------------------------------------------------------------- budget

test('the budget is percentage of context, then capped', () => {
  // The translation the prompt call site runs: the default 25% of a 4 096
  // window, a cap that only bites above it, and the floor at 1 that keeps an
  // always-allowing budget from being zero.
  assert.equal(computeBudget(4096, 25, 0), 1024)
  assert.equal(computeBudget(4096, 25, 512), 512)
  assert.equal(computeBudget(4096, 0, 0), 1)
})
