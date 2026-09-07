/**
 * The character library's content filter, as a function that can be tested.
 *
 * Lifted out of `Sidebar.tsx` for one reason: the sidebar is a `.tsx` module and
 * Node's type stripping does not transform JSX, so no `node --test` file can
 * import it — a fact about the filter would have had to be pinned against the
 * *source text* of the component, the way `sidebar-tabs.test.ts` pins the
 * tablist. This rule is behaviour, not markup, so it gets a real test instead.
 *
 * @module iris-web/app/library-search
 */

import type { CharacterSummary } from '@iris/protocol'

/**
 * Whether one library row answers a reader's query.
 *
 * Three fields are searched — the name, the tags, and the **opening of the
 * description** that `CharacterSummary` now carries — and a hit in any of them
 * is the same hit: no field is weighted, because the list is already sorted by
 * the reader's chosen order (name / recency / starred) and re-ranking it by
 * where the match landed would move rows for a reason nothing on screen
 * explains.
 *
 * Substring rather than prefix, and case-folded on both sides. Both were
 * settled by the corpus: a card is called `不要被神隐挑战 V1.5.4 测试版` and a
 * reader looking for it types 神隐, and an English card's tags are lower-case
 * while its name is not.
 *
 * **The description is a clip, so this search is a clip too.** The protocol
 * carries at most the first 200 code points (`CharacterSummary.description`) —
 * a whole card is a median of 494 KiB and up to 2.8 MiB, and none of it is on
 * the wire for a list. A word further into a long description therefore does
 * not match here, and cannot: nothing in the client has the rest of the text.
 * The alternative is a host-side search RPC, which is what `chat.search` is for
 * conversations; the library has no equivalent yet.
 *
 * @param character - the row to test.
 * @param query - the raw contents of the search box; blank matches everything.
 * @returns whether the row should show.
 */
export function matchesLibraryQuery(character: CharacterSummary, query: string): boolean {
  /*
   * The fold happens here rather than at the call site, so that a caller cannot
   * pass a raw query against pre-folded fields and get a filter that quietly
   * only works in lower case — which is exactly the bug a test written against
   * a pre-folded parameter would also have missed.
   *
   * Its cost is one `trim`/`toLowerCase` of a short string per row per
   * keystroke, over a list whose whole point is that it is small enough to
   * filter client-side (the corpus library is 19 cards).
   */
  const needle = query.trim().toLowerCase()
  if (needle === '') return true
  if (character.name.toLowerCase().includes(needle)) return true
  if (character.tags.some(tag => tag.toLowerCase().includes(needle))) return true
  // Absent for most real cards — 15 of the 19 local ones carry no description
  // at all — so this is the branch that runs, and it must not throw.
  return character.description?.toLowerCase().includes(needle) ?? false
}
