import { join } from 'node:path'

import type { CharacterCard } from '@iris/character'

import { ChatStore } from '../../src/chats.ts'
import type { CharacterLibrary } from '../../src/library.ts'
import { materialiseEmbeddedBook, WorldbookBindingStore } from '../../src/materialise.ts'
import { WorldbookStore } from '../../src/worldbooks.ts'

/**
 * A `ChatStore` configured the way the real host configures one.
 *
 * **Why fixtures need this now.** A card's embedded `character_book` is no
 * longer read at assembly time — SillyTavern's assembly layer reads only the
 * bound name, and the embedded book reaches it by being materialised into a
 * named book first. So a host with nowhere to put named books has no world-info
 * channel at all, and a card whose only book is embedded has no world info.
 *
 * That is the correct consequence rather than a gap to paper over: named books
 * need a directory to live in. Production always builds a `WorldbookStore`
 * (`index.ts:360`, unconditional), so the only under-configured hosts were
 * fixtures — they were relying on a channel that no longer exists. This gives
 * them the same three pieces production has: somewhere to write books, a table
 * recording which book each card's embedded copy became, and the one function
 * that runs on both the import and open paths.
 * @param dir - the fixture's profile directory.
 * @param library - the card library, as the fixture built it.
 * @param charBooks - the per-character additional bindings reader, as the
 *   production composition passes one. Absent leaves the store without the
 *   channel, which is what fixtures that never bind extras want.
 * @returns a store that materialises embedded books on open.
 */
export function materialisingChatStore(
  dir: string,
  library: CharacterLibrary,
  charBooks?: (characterId: string) => readonly string[],
): ChatStore {
  const worldbooks = new WorldbookStore(join(dir, 'worlds'))
  const bindings = new WorldbookBindingStore(join(dir, 'worldbook-bindings.json'))
  return new ChatStore(
    join(dir, 'chats'),
    library,
    undefined,
    undefined,
    worldbooks,
    () => [],
    async (characterId: string | undefined, card: CharacterCard | undefined) => {
      if (characterId === undefined) return undefined
      const done = await materialiseEmbeddedBook(characterId, card, worldbooks, bindings)
      return done?.name
    },
    undefined,
    undefined,
    charBooks,
  )
}
