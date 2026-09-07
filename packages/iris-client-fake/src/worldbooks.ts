/**
 * The named world books the fake starts with.
 *
 * **Why this exists at all**, when the same client's world-book arm used to
 * answer "this host has none" and defended that as a true answer rather than a
 * stand-in: it *was* true, and it stopped being the useful truth. A panel
 * developed against an empty book store gets its empty state polished and its
 * dense state discovered on a user's machine — which is exactly what happened.
 * A reader with nine books and one card could not tell which book was theirs,
 * and no check in this repository could have shown that, because every check
 * ran against a store with nothing in it.
 *
 * **The shape is the point, not the contents.** Four books, deliberately
 * differing in *how they came to exist*, because that is the fact the panel
 * groups by:
 *
 * - One materialised from the open card's embedded book, under a name that is
 *   **not** the card's name and **not** the card's own binding. This is the
 *   measured failure, reproduced: the user's card said "140 entries embedded",
 *   the book on disk was called `【Sgw】『普通』和『理所当然』是什么呢 2.3（好感度x10版）`,
 *   and the panel laid it out among nine strangers.
 * - One the user made and bound to a *different* card by hand, so "which of
 *   these is mine" has a wrong answer available to be gotten wrong — and so
 *   that the weaker of the two ownership rules (match on the name a card binds,
 *   rather than on what this host materialised) is exercised at all.
 * - Two nobody bound, which this host has no provenance record for — the common
 *   case on a profile imported from SillyTavern, and the case a client that
 *   only modelled materialised books would never render.
 *
 * One of them is globally selected, because a global selection over an empty
 * list is not a rendering of anything.
 *
 * @module @iris/client-fake/worldbooks
 */

import type { CardWorldbookView, WorldbookEntry } from '@iris/protocol'

/** One seeded book: its name, its size, and where it came from. */
export interface FakeWorldbook {
  /** The book's name, used verbatim — the panel matches bindings on it. */
  name: string
  /** How many entries {@link fakeBookEntries} generates for it. */
  entryCount: number
  /**
   * The card this book was materialised from, when one was.
   *
   * Absent for a book the user made in SillyTavern: this host wrote no binding
   * for it, so it has no owner to report, and a panel must render that without
   * claiming the book belongs to nobody's card — only that this host does not
   * know.
   */
  fromCharacterId?: string
  /** A word the generated entries are keyed on, so a search has something to find. */
  keyword: string
}

/**
 * The seeded books.
 *
 * Sorted by name the way `WorldbookStore.names()` sorts — `localeCompare` — so
 * a client reading this list sees the order a real host would answer in and a
 * panel that forgot to sort is not accidentally correct here.
 */
export const FAKE_WORLDBOOKS: readonly FakeWorldbook[] = [
  {
    /*
     * Bound by hand, never materialised — and coherently so: Aria's card
     * embeds no book at all (`seedCharacters` gives her no `bookEntryCount`),
     * so there was nothing for this host to write out. It is the ordinary
     * SillyTavern shape: the user made a book, then bound it to a card. The
     * only link between the two is the *name*, which is the weaker of the two
     * rules a panel can match on, and the one that has to be modelled or it
     * would never be exercised.
     */
    name: "Aria's northern survey",
    entryCount: 12,
    keyword: 'sandbar',
  },
  {
    // The user's own book, name and all: made in SillyTavern, bound to nothing,
    // and globally selected. It is the one that "pollutes" every chat, and the
    // panel has to be able to say that it does.
    name: '共享设定：雨季',
    entryCount: 7,
    keyword: '雨季',
  },
  {
    name: '潮汐表（未整理）',
    entryCount: 3,
    keyword: '潮汐',
  },
  {
    /*
     * The open card's book, and the whole reason this seed exists.
     *
     * Three things are true of it at once, and every one of them is what made
     * the real panel unreadable: the name is not the card's name (络络), it is
     * not the card's own binding either (`络络的世界`, which has no file — the
     * host minted this name when the wanted one collided), and its size is the
     * same 34 the character page reports as the card's *embedded* count,
     * because the file was written from that book.
     */
    name: '络络的世界 2.1（好感度x10版）',
    entryCount: 34,
    fromCharacterId: 'luoluo',
    keyword: '灯',
  },
]

/** Which books are selected for every chat. Upstream's `world_info.globalSelect`. */
export const FAKE_GLOBAL_SELECT: readonly string[] = ['共享设定：雨季']

/**
 * The card binding the fake reports for each character.
 *
 * Keyed by character id, and **deliberately not derivable** from
 * {@link FAKE_WORLDBOOKS}: the interesting cases are the ones where the card's
 * own binding and the book that actually plays disagree, so the two have to be
 * stated separately or the disagreement cannot be modelled.
 */
export const FAKE_CARD_BINDINGS: Readonly<Record<string, { primary: string | null }>> = {
  /*
   * A dangling binding, which is a real shape — 2 of the corpus's 18 bindings
   * are — and here it is the *reason* the host minted a different name. The
   * card asks for `络络的世界`; no such file exists; the book that plays is the
   * materialised one above.
   */
  luoluo: { primary: '络络的世界' },
  /* A binding that resolves, to a book nothing here materialised. */
  'aria-vance': { primary: "Aria's northern survey" },
  /* A plain V1 card: no binding, no embedded book, and so no world info. */
  'the-archivist': { primary: null },
}

/**
 * Which book one card's world info comes from here.
 *
 * **The host's rule, transcribed, not a second rule.** `cardWorldbookView` in
 * `@iris/app-service/worldbooks` resolves the name as
 * `materialised ?? card.extensions.world`, then counts the file if there is
 * one and the embedded book if there is not. This does exactly that against
 * the seed, in that order, so a panel that reads this answer and a panel
 * reading a real host's cannot be shown different shapes.
 * @param characterId - whose card.
 * @param embeddedCount - the card's own `character_book` size, or undefined
 *   when it embeds no book — `CharacterSummary.bookEntryCount`, so the two
 *   numbers a reader can see at once come from one place.
 * @returns the book, its size, and where the count came from.
 */
export function fakeCardWorldbook(
  characterId: string,
  embeddedCount: number | undefined,
): CardWorldbookView {
  const own = FAKE_CARD_BINDINGS[characterId]?.primary ?? null
  const materialised = FAKE_WORLDBOOKS.find(book => book.fromCharacterId === characterId)?.name
  const bound = materialised ?? own
  const minted = materialised !== undefined && materialised !== own

  const file = bound === null ? undefined : FAKE_WORLDBOOKS.find(book => book.name === bound)
  if (file !== undefined) {
    return { name: file.name, source: 'named', entryCount: file.entryCount, materialised: minted }
  }
  if (embeddedCount !== undefined) {
    return { name: bound, source: 'embedded', entryCount: embeddedCount, materialised: minted }
  }
  return { name: null, source: 'none', entryCount: 0, materialised: false }
}

/**
 * Generate one book's entries.
 *
 * Generated rather than written out: 34 hand-authored entries would be 34
 * chances for the file's count and the seed's `entryCount` to disagree, and
 * that disagreement is precisely the lie this client exists not to tell. The
 * count is the input, so `worldbook.names`' count and `worldbook.get`'s length
 * are one number read twice.
 *
 * The fields are the protocol's defaults for a plain keyword entry — nothing
 * exotic, because a panel rendering these is being checked on layout and
 * grouping, not on the entry editor's field coverage, which
 * `worldbook-editor.test.ts` owns.
 * @param book - the book to generate for.
 * @returns its entries, in display order.
 */
export function fakeBookEntries(book: FakeWorldbook): WorldbookEntry[] {
  return Array.from({ length: book.entryCount }, (_unused, index) => ({
    uid: index,
    name: `${book.keyword} ${String(index + 1)}`,
    enabled: true,
    strategy: {
      type: 'selective' as const,
      keys: [`${book.keyword}${String(index + 1)}`],
      keys_secondary: { logic: 'and_any' as const, keys: [] },
      scan_depth: 'same_as_global' as const,
    },
    position: { type: 'at_depth' as const, role: 'system' as const, depth: 4, order: 100 },
    content: `${book.name} — ${book.keyword} ${String(index + 1)}`,
    probability: 100,
    useProbability: true,
    recursion: { prevent_incoming: false, prevent_outgoing: false, delay_until: null },
    effect: { sticky: null, cooldown: null, delay: null },
    addMemo: true,
    group: '',
    groupOverride: false,
    groupWeight: 100,
    caseSensitive: null,
    matchWholeWords: null,
    outletName: '',
    automationId: '',
    useGroupScoring: null,
    ignoreBudget: false,
    triggers: [],
    characterFilter: { isExclude: false, names: [], tags: [] },
    matchPersonaDescription: false,
    matchCharacterDescription: false,
    matchCharacterPersonality: false,
    matchCharacterDepthPrompt: false,
    matchScenario: false,
    matchCreatorNotes: false,
  }))
}
