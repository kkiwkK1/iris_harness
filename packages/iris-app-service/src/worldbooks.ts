/**
 * Named world books: the ones that live in their own files, not inside a card.
 *
 * **Why this module exists at all is the finding.** Iris had no named-book
 * storage of any kind — `worldInfoOf` and `prompt.ts` read `data.character_book`
 * and nothing else. Against the corpus that is not a small omission: **18 of 19
 * cards bind a named book** through `data.extensions.world`, 16 of those names
 * resolve to a file, and the 18 book files hold **1478 entries** between them.
 * 17 cards carry *both* an embedded book and a binding, so for those the host
 * was assembling prompts from half of each card's world info.
 *
 * **What a binding is, precisely.** `data.extensions.world` is a **name**, not
 * content — a reference to `worlds/<name>.json`. The card's embedded
 * `character_book` is a separate, unrelated body of entries. TavernHelper's four
 * worldbook members operate exclusively on the named files; none of them reads
 * or writes `character_book`. That is what keeps them clear of the standing
 * ruling that runtime state must not be written into a shared card file.
 *
 * **Names are used verbatim, and that is load-bearing.** All 18 real names pass
 * {@link isSafeId}, but **13 of 18 are changed by `toId`** — `创世回廊1.3`
 * becomes `创世回廊1`, `[SG]可攻略女主拒绝被攻略` loses its brackets. A card's
 * binding holds the exact name, so an id derived through `toId` would fail to
 * match the file for two thirds of the corpus while looking perfectly reasonable
 * in code. `fileFor` is asked for the containment guard; the name itself is
 * never transformed.
 *
 * @module @iris/app-service/worldbooks
 */

import { readFile, readdir } from 'node:fs/promises'

import { fromCharacterBook, parseLorebook, type Lorebook, type LorebookEntry } from '@iris/lorebook'
import type { CharacterCard } from '@iris/character'
import type { SecondaryLogic, WorldbookEntry, WorldbookPosition } from '@iris/protocol'

import { notFound } from './errors.ts'
import { fileFor } from './paths.ts'

/** The books a card is bound to, by name. */
export interface CharWorldbookNames {
  /** `data.extensions.world`, or null when the card binds nothing. */
  primary: string | null
  /**
   * Extra books bound through the installation's settings rather than the card.
   *
   * Upstream reads `world_info.charLore[<avatar stem>].extraBooks`. The measured
   * install has **no `world_info` section at all**, so this is empty for every
   * card in the corpus — the shape is taken from upstream's source, not from
   * data, and nothing here has ever been exercised by a real file.
   */
  additional: string[]
}

const POSITIONS: Record<number, WorldbookPosition> = {
  0: 'before_character_definition',
  1: 'after_character_definition',
  2: 'before_author_note',
  3: 'after_author_note',
  4: 'at_depth',
  5: 'before_example_messages',
  6: 'after_example_messages',
  7: 'outlet',
}

const LOGICS: Record<number, SecondaryLogic> = {
  0: 'and_any',
  1: 'not_all',
  2: 'not_any',
  3: 'and_all',
}

const ROLES: Record<number, 'system' | 'user' | 'assistant'> = {
  0: 'system',
  1: 'user',
  2: 'assistant',
}

/**
 * A positive number, or null.
 *
 * Upstream writes this test out three times for sticky, cooldown and delay, and
 * the shared point is that 0 and "off" are one state on disk but two in the
 * shape a card reads. A card checking `if (entry.effect.sticky)` behaves the
 * same either way; one destructuring a default does not.
 * @param value - the field as stored.
 * @returns the number when it is above zero, else null.
 */
function positive(value: number | boolean | null | undefined): number | null {
  return typeof value === 'number' && value > 0 ? value : null
}

/**
 * Translate one stored entry into the shape a card script expects.
 * @param entry - the entry as normalized by `@iris/lorebook`.
 * @returns TavernHelper's `WorldbookEntry`.
 */
export function toWorldbookEntry(entry: LorebookEntry): WorldbookEntry {
  return {
    uid: entry.uid,
    name: entry.comment,
    enabled: !entry.disable,
    strategy: {
      type: entry.constant ? 'constant' : entry.vectorized ? 'vectorized' : 'selective',
      keys: [...entry.key],
      keys_secondary: {
        logic: LOGICS[entry.selectiveLogic] ?? 'and_any',
        keys: [...entry.keysecondary],
      },
      scan_depth: entry.scanDepth ?? 'same_as_global',
    },
    position: {
      type: POSITIONS[entry.position] ?? 'at_depth',
      role: ROLES[entry.role] ?? 'system',
      depth: entry.depth,
      order: entry.order,
    },
    content: entry.content,
    probability: entry.useProbability ? entry.probability : 100,
    recursion: {
      prevent_incoming: entry.excludeRecursion,
      prevent_outgoing: entry.preventRecursion,
      delay_until: positive(entry.delayUntilRecursion),
    },
    effect: {
      sticky: positive(entry.sticky),
      cooldown: positive(entry.cooldown),
      delay: positive(entry.delay),
    },
    addMemo: entry.addMemo,
    group: entry.group,
    groupOverride: entry.groupOverride,
    groupWeight: entry.groupWeight,
    caseSensitive: entry.caseSensitive,
    matchWholeWords: entry.matchWholeWords,
    matchPersonaDescription: entry.matchPersonaDescription,
    matchCharacterDescription: entry.matchCharacterDescription,
    matchCharacterPersonality: entry.matchCharacterPersonality,
    matchCharacterDepthPrompt: entry.matchCharacterDepthPrompt,
    matchScenario: entry.matchScenario,
    matchCreatorNotes: entry.matchCreatorNotes,
  }
}

/**
 * The books a card binds, by name.
 *
 * Names only, and deliberately: upstream returns names here and makes the caller
 * fetch contents separately, so a card listing its books does not pay for
 * reading them. A dangling name — bound but with no file behind it, which 2 of
 * the corpus's 18 bindings are — is still reported, because the binding is a
 * fact about the card whatever the disk holds.
 * @param card - the card, or undefined when none is open.
 * @param extraBooks - names bound through settings, if the installation has any.
 * @returns the primary binding and any additional ones.
 */
export function charWorldbookNames(
  card: CharacterCard | undefined,
  extraBooks: readonly string[] = [],
): CharWorldbookNames {
  const world = card?.data.extensions?.['world']
  return {
    primary: typeof world === 'string' && world.length > 0 ? world : null,
    additional: [...extraBooks],
  }
}

/**
 * The named world books beside an installation.
 *
 * Reads only. The write members of the same family are a ruling item, not an
 * implementation one, and this class deliberately offers them no foothold: it
 * has no save path to be extended by accident.
 */
export class WorldbookStore {
  private readonly dir: string

  /**
   * @param dir - the profile's `worlds` directory. It need not exist; an
   *   installation with no books is a normal state, not an error.
   */
  constructor(dir: string) {
    this.dir = dir
  }

  /**
   * Every book that has a file, by name.
   * @returns the names, sorted, or an empty list when the directory is absent.
   */
  async names(): Promise<string[]> {
    let files: string[]
    try {
      files = await readdir(this.dir)
    } catch {
      // Absent is empty. A fresh profile has no `worlds` directory, and a card
      // asking what books exist deserves "none" rather than a filesystem error
      // it can do nothing about.
      return []
    }
    return files
      .filter(name => name.endsWith('.json'))
      .map(name => name.slice(0, -'.json'.length))
      .sort((left, right) => left.localeCompare(right))
  }

  /**
   * One book, in the shape a card script reads.
   *
   * Sorted by `displayIndex`, matching upstream — that is the order the user
   * arranged in the editor, and it is not the same as uid order.
   * @param name - the book's name, exactly as a card's binding spells it.
   * @returns its entries.
   * @throws {AppError} `not-found` when no book has that name.
   */
  async get(name: string): Promise<WorldbookEntry[]> {
    const book = await this.read(name)
    return Object.values(book.entries)
      .sort((left, right) => left.displayIndex - right.displayIndex)
      .map(toWorldbookEntry)
  }

  /**
   * One book as stored, for callers that need the file's own shape.
   * @param name - the book's name.
   * @returns the normalized book.
   * @throws {AppError} `not-found` when no book has that name.
   */
  async read(name: string): Promise<Lorebook> {
    // Checked against the listing rather than by catching a read failure, so a
    // name that is merely absent is told apart from one that escapes the
    // directory — `fileFor` refuses the second with its own message.
    const path = fileFor(this.dir, name, '.json')
    let raw: string
    try {
      raw = await readFile(path, 'utf8')
    } catch {
      throw notFound(`world book "${name}"`)
    }
    return parseLorebook(JSON.parse(raw))
  }
}

/**
 * Which book a card's world info actually comes from.
 *
 * The three cases are kept distinct rather than collapsed into "the entries",
 * because the reason a card has no world info is the first thing anyone asks
 * when it behaves as though it has none.
 */
export interface ResolvedWorldbook {
  /** The entries to assemble from, already normalized. */
  entries: LorebookEntry[]
  /** What the entries came from. */
  source: 'named' | 'embedded' | 'none'
  /** The book's name, for attribution on each entry. */
  world: string
}

/**
 * Choose the one book a card's world info comes from.
 *
 * **Choose, never combine — that is the whole rule.** SillyTavern's embedded
 * `character_book` is an *import-time* source: `world-info.js:5618` prompts the
 * user, converts it, saves it as a named book and binds it back onto the card,
 * and `world-info.js:4363` `getCharacterLore()` then reads named books only and
 * never looks at `character_book` again. So on a real installation the bound
 * book **is** the embedded book, copied. Measured on the corpus: 15 cards carry
 * both, 14 of them are identical entry for entry, and the fifteenth differs by
 * one entry that was edited after import. Assembling both sources would produce
 * **2246 entries where 1122 are duplicates** — a failure that is invisible in a
 * diff, costs twice the world-info budget, and reads as a model that has begun
 * repeating itself. `scripts/worldbook-source-census.mjs` keeps that number in
 * view; anyone reaching for a union should run it first.
 *
 * The rules, in order:
 *
 * 1. **A binding that resolves wins.** This is upstream's semantics, and it is
 *    also the copy the user edits — the one card whose two books disagree
 *    disagrees because the named one was edited afterwards.
 * 2. **Otherwise fall back to the embedded book.** This is deliberately
 *    *better* than upstream, which reads nothing here until the user accepts an
 *    import prompt. The deviation is safe in a way upstream's is not: their
 *    prompt exists because importing is a data migration that writes a new file
 *    and rebinds the card, and a migration deserves consent. This fallback only
 *    reads. The cost is that a card whose binding is broken keeps playing from
 *    a stale embedded copy instead of visibly losing its world info — which is
 *    the better failure of the two, and the corpus has 2 such cards carrying 102
 *    and 153 entries that would otherwise go silent.
 * 3. **Never both.** See above.
 *
 * @param card - the character being played.
 * @param store - the named books, when the host has them.
 * @returns the chosen entries and where they came from.
 */
export async function resolveCardWorldbook(
  card: CharacterCard | undefined,
  store: WorldbookStore | undefined,
): Promise<ResolvedWorldbook> {
  const fallbackName = card?.data.name ?? 'character book'
  const bound = charWorldbookNames(card).primary

  if (bound !== null && store !== undefined) {
    try {
      const book = await store.read(bound)
      return { entries: Object.values(book.entries), source: 'named', world: bound }
    } catch {
      // A binding with no file behind it, or a file this build cannot parse.
      // Falls through to the embedded book rather than refusing: rule 2 exists
      // precisely for this card, and the corpus has two of them.
    }
  }

  const embedded = card?.data.character_book
  if (embedded !== undefined) {
    try {
      return {
        entries: Object.values(fromCharacterBook(embedded).entries),
        source: 'embedded',
        world: fallbackName,
      }
    } catch {
      // A book Iris cannot read is a reason to play the character without it,
      // not a reason to refuse the chat.
    }
  }

  return { entries: [], source: 'none', world: fallbackName }
}
