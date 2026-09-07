/**
 * The listing shape of a world book entry, derived in one place.
 *
 * **In the contract because both halves derive it**, which is the same argument
 * `bundle-specifiers.ts` is here for. The host maps real books — a file it read
 * off disk, or a card's embedded `character_book` — and the fake client maps its
 * own seeded ones, and a page that reads both must not be able to tell them
 * apart by which fields arrived. Two implementations of this mapping would drift
 * silently: every field is optional-or-scalar, so a half missing `constant` or
 * inverting `enabled` is a wrong answer, not a type error.
 *
 * @module @iris/protocol/digests
 */

import type { WorldbookEntry, WorldbookEntryDigest } from './views.ts'

/**
 * Reduce one entry to what a listing shows.
 *
 * Three fields are *dropped* rather than carried, and each drop is the point:
 * `content` (the injected text, the bulk of a book), the secondary-key logic,
 * and `depth` for every position that does not use one. See
 * {@link WorldbookEntryDigest} for why each.
 * @param entry - the entry in the shape a card script reads.
 * @returns the same entry with its content, and its noise, left behind.
 */
export function toEntryDigest(entry: WorldbookEntry): WorldbookEntryDigest {
  const secondary = entry.strategy.keys_secondary.keys
  return {
    uid: entry.uid,
    name: entry.name,
    enabled: entry.enabled,
    constant: entry.strategy.type === 'constant',
    keys: [...entry.strategy.keys],
    ...secondary.length === 0 ? {} : { keysSecondary: [...secondary] },
    position: entry.position.type,
    // Only where the number means something. `at_depth` is the one position
    // whose depth is read; every other entry carries the field's default and
    // would otherwise be reported as though its author had chosen it.
    ...entry.position.type === 'at_depth' ? { depth: entry.position.depth } : {},
  }
}
