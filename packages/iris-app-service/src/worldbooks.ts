/**
 * Named world books: the ones that live in their own files, not inside a card.
 *
 * **Why this module exists at all is the finding.** Iris had no named-book
 * storage of any kind — `worldInfoOf` and `prompt.ts` read `data.character_book`
 * and nothing else. Against the corpus that is not a small omission: **18 of 19
 * cards bind a named book** through `data.extensions.world`, 16 of those names
 * resolve to a file, and the 18 book files hold **1478 entries** between them —
 * an *upper bound*, not a working figure: only 288 of those are always injected
 * and 336 are reachable by no path at all. `notes/packages/iris-app-service/WORLDBOOKS.md §2b` carries the
 * funnel.
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

import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises'

import { fromCharacterBook, parseLorebook, type Lorebook, type LorebookEntry } from '@iris/lorebook'
import type { CharacterCard } from '@iris/character'
import { toEntryDigest } from '@iris/protocol'
import type {
  CardBookDigest,
  CardWorldbookView,
  SecondaryLogic,
  WorldbookEntry,
  WorldbookEntryDigest,
  WorldbookPosition,
} from '@iris/protocol'

import { invalid, notFound } from './errors.ts'
import { fileFor } from './paths.ts'

/** The books a card is bound to, by name. */
export interface CharWorldbookNames {
  /** `data.extensions.world`, or null when the card binds nothing. */
  primary: string | null
  /**
   * Extra books bound through the installation's settings rather than the card.
   *
   * Upstream reads `world_info.charLore[<avatar stem>].extraBooks`, where
   * `world_info` sits under **`settings.json` → `world_info_settings`** — not at
   * the top level, which is where an earlier version of this note said to look
   * and found nothing.
   *
   * That section does exist in the measured install; it holds `globalSelect` and
   * no `charLore`. So this list is still empty for every corpus card, but for a
   * narrower reason than "the section is missing" — and the difference matters,
   * because the wrong reason would keep reporting the same answer after someone
   * added extra books. The shape below comes from upstream's source, not from
   * data; nothing here has been exercised by a real file.
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
 * The implicit keys upstream fills in, with its defaults.
 *
 * Named `_default_implicit_keys` upstream. They are "implicit" because the
 * card-facing shape does not surface them as a group: a caller may set any of
 * them, and one that does not gets these.
 */
const DEFAULT_IMPLICIT_KEYS = {
  addMemo: true,
  matchPersonaDescription: false,
  matchCharacterDescription: false,
  matchCharacterPersonality: false,
  matchCharacterDepthPrompt: false,
  matchScenario: false,
  matchCreatorNotes: false,
  group: '',
  groupOverride: false,
  groupWeight: 100,
  caseSensitive: null,
  matchWholeWords: null,
} as const

/** The reverse of {@link POSITIONS}. */
const POSITION_CODES: Record<WorldbookPosition, number> = {
  before_character_definition: 0,
  after_character_definition: 1,
  before_author_note: 2,
  after_author_note: 3,
  at_depth: 4,
  before_example_messages: 5,
  after_example_messages: 6,
  outlet: 7,
}

/** The reverse of {@link LOGICS}. */
const SELECTIVE_LOGIC: Record<SecondaryLogic, number> = {
  and_any: 0,
  not_all: 1,
  not_any: 2,
  and_all: 3,
}

/** The reverse of {@link ROLES}. */
const ROLE_CODES: Record<'system' | 'user' | 'assistant', number> = {
  system: 0,
  user: 1,
  assistant: 2,
}

/**
 * A card-facing entry as a writer may supply it: everything optional but `uid`.
 *
 * Upstream's `PartialDeep<WorldbookEntry>`, narrowed to the nesting this host
 * actually reads. Written out rather than derived so the optionality is visible
 * at the point where the defaults in {@link fromWorldbookEntry} are chosen —
 * "which fields does omitting change the meaning of" is the question that
 * matters here, and a mapped type hides it.
 */
export interface PartialWorldbookEntry {
  uid: number
  name?: string | undefined
  enabled?: boolean | undefined
  strategy?: {
    type?: 'constant' | 'vectorized' | 'selective' | undefined
    keys?: readonly string[] | undefined
    keys_secondary?: { logic?: SecondaryLogic | undefined, keys?: readonly string[] | undefined } | undefined
    scan_depth?: number | 'same_as_global' | undefined
  } | undefined
  position?: {
    type?: WorldbookPosition | undefined
    role?: 'system' | 'user' | 'assistant' | undefined
    depth?: number | undefined
    order?: number | undefined
  } | undefined
  content?: string | undefined
  probability?: number | undefined
  recursion?: {
    prevent_incoming?: boolean | undefined
    prevent_outgoing?: boolean | undefined
    delay_until?: number | null | undefined
  } | undefined
  effect?: {
    sticky?: number | null | undefined
    cooldown?: number | null | undefined
    delay?: number | null | undefined
  } | undefined
  addMemo?: boolean | undefined
  group?: string | undefined
  groupOverride?: boolean | undefined
  groupWeight?: number | undefined
  caseSensitive?: boolean | null | undefined
  matchWholeWords?: boolean | null | undefined
  outletName?: string | undefined
  matchPersonaDescription?: boolean | undefined
  matchCharacterDescription?: boolean | undefined
  matchCharacterPersonality?: boolean | undefined
  matchCharacterDepthPrompt?: boolean | undefined
  matchScenario?: boolean | undefined
  matchCreatorNotes?: boolean | undefined
  /**
   * The stored shape's remaining fields, added with the shell's entry editor.
   * Before these, a whole-book save rebuilt every row from a field list that
   * could not name them: an automation binding, a per-entry group-scoring
   * override, a budget exemption, a character filter or a generation-trigger
   * filter was dropped by the very act of saving the book it lived in. Each is
   * optional, and {@link fromWorldbookEntry} defaults each exactly as it
   * defaults its own fields, so callers that never heard of them are unmoved.
   */
  automationId?: string | undefined
  useGroupScoring?: boolean | null | undefined
  ignoreBudget?: boolean | undefined
  useProbability?: boolean | undefined
  triggers?: readonly string[] | undefined
  characterFilter?: {
    isExclude: boolean
    names: readonly string[]
    tags: readonly string[]
  } | undefined
}

/**
 * The implicit keys a caller actually set, so they can override the defaults.
 * @param entry - the caller's partial entry.
 * @returns only the implicit keys present on it.
 */
function pickImplicit(entry: PartialWorldbookEntry): Record<string, unknown> {
  const picked: Record<string, unknown> = {}
  for (const key of Object.keys(DEFAULT_IMPLICIT_KEYS)) {
    const value = (entry as unknown as Record<string, unknown>)[key]
    if (value !== undefined) picked[key] = value
  }
  return picked
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
    outletName: entry.outletName,
    matchPersonaDescription: entry.matchPersonaDescription,
    matchCharacterDescription: entry.matchCharacterDescription,
    matchCharacterPersonality: entry.matchCharacterPersonality,
    matchCharacterDepthPrompt: entry.matchCharacterDepthPrompt,
    matchScenario: entry.matchScenario,
    matchCreatorNotes: entry.matchCreatorNotes,
    // The raw flag, not the resolved one `probability` carries: an entry that
    // does not use probability reads `useProbability: false, probability: 100`
    // here, and a caller writing the book back needs the flag to put the two
    // fields back the way the file had them. The collection fields below fall
    // back rather than reach a caller as `undefined` — the same rule
    // `position` and `role` follow for a file a newer SillyTavern wrote.
    useProbability: entry.useProbability === false ? false : true,
    ignoreBudget: entry.ignoreBudget === true,
    automationId: typeof entry.automationId === 'string' ? entry.automationId : '',
    useGroupScoring: typeof entry.useGroupScoring === 'boolean' ? entry.useGroupScoring : null,
    triggers: Array.isArray(entry.triggers) ? entry.triggers.map(String) : [],
    characterFilter: {
      isExclude: entry.characterFilter?.isExclude === true,
      names: Array.isArray(entry.characterFilter?.names) ? entry.characterFilter.names.map(String) : [],
      tags: Array.isArray(entry.characterFilter?.tags) ? entry.characterFilter.tags.map(String) : [],
    },
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
 * Reads, and three writes, each at the granularity of a whole file:
 * {@link WorldbookStore.replace} rewrites one that exists,
 * {@link WorldbookStore.create} writes one that does not, and
 * {@link WorldbookStore.remove} deletes one. There is deliberately **no
 * per-entry write** — upstream's `replaceWorldbook` refuses a book that does
 * not exist, and every other write member in that family (including the old
 * `*LorebookEntries` four) is built on top of the same whole-book replacement.
 *
 * The line between `replace` and `create` is not tidiness: an edit must not
 * create and a materialisation must not overwrite, and an upsert would let each
 * one do the other's damage silently. `remove` is the one arm whose failure
 * cannot be undone, which is why its caller carries a report.
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
   * Every book that has a file, with its entry count.
   *
   * **Deliberately separate from {@link names}, and deliberately not folded
   * into it.** `names` answers a directory listing; this opens all 18 books to
   * count them, which is exactly the cost the module header says a listing must
   * not pay. The two callers want opposite things: a card asking what books
   * exist wants the cheap answer, a panel drawing a chooser wants the counts,
   * and `worldbook.names`' `withCounts` is where the caller says which.
   *
   * A file that will not parse is **left out** rather than reported as empty. A
   * zero here would be read as a book the user emptied, and "I could not read
   * it" is a different repair from "there is nothing in it"; the name is still
   * in {@link names}, so the book does not vanish — it appears without a count.
   * @returns one row per readable book, in {@link names}' order.
   */
  async summaries(): Promise<{ name: string, entryCount: number }[]> {
    const rows: { name: string, entryCount: number }[] = []
    for (const name of await this.names()) {
      try {
        const book = await this.read(name)
        rows.push({ name, entryCount: Object.keys(book.entries).length })
      } catch {
        // Unreadable or unparseable. See above: absent, not zero.
      }
    }
    return rows
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

  /**
   * One book exactly as it sits on disk, with no normalisation.
   *
   * **Deliberately not {@link read}.** The two upstream APIs for the same book
   * return different shapes: `SillyTavern.loadWorldInfo(name)` hands back the
   * raw saved object — `entries` keyed by uid — while TavernHelper's
   * `getWorldbook()` hands back a normalised array. A card picks one and gets
   * that shape, so serving the normalised form here would answer a different
   * question than the one asked, and MVU's own guard
   * (`isPlainObject(loaded) && isPlainObject(loaded.entries)`) is exactly what
   * fails when the shape is wrong.
   *
   * **No cache, on purpose.** Upstream keeps a process-level `worldInfoCache`
   * whose invalidation nobody has yet located, so a book edited after being
   * read can be served stale there. Reading the file each time is strictly
   * fresher; the cost is a file read on a path that runs once per chat-level
   * init, which is not where anyone's latency is.
   * @param name - the book's name, used verbatim as the filename.
   * @returns the parsed file, or undefined when there is no such book.
   */
  async readRaw(name: string): Promise<unknown> {
    const path = fileFor(this.dir, name, '.json')
    try {
      return JSON.parse(await readFile(path, 'utf8')) as unknown
    } catch {
      // Absent, unreadable, or not JSON. The caller is told "no book", which is
      // upstream's own answer for a name that does not resolve.
      return undefined
    }
  }

  /**
   * Replace a book's entire contents.
   *
   * **Whole-book, and that is upstream's semantics rather than a shortcut.**
   * `createOrReplaceWorldbook` builds the saved object fresh from the array it
   * is given, so an entry the caller did not include is gone. A partial update
   * is expressed by reading the book, changing what you want, and writing all of
   * it back — which is exactly what `updateWorldbookWith` does, and why that
   * member cannot live on this side of the wire: it takes a function.
   *
   * The append-only rule that governs the chat log does **not** apply here. A
   * book is a document the user edits in another application, not a history this
   * host is the custodian of; rewriting it is the operation, not a violation.
   *
   * Written through a temporary file and renamed, because the alternative to an
   * atomic replace is a truncated book: a crash midway through writing 167
   * entries leaves a file that parses as a smaller book rather than as an error,
   * and the user's next read finds their world quietly shortened.
   * @param name - the book's name, exactly as spelled. It must already exist.
   * @param entries - the complete new contents.
   * @returns the entries as stored, read back.
   * @throws {AppError} `not-found` when no book has that name.
   */
  async replace(name: string, entries: readonly PartialWorldbookEntry[]): Promise<WorldbookEntry[]> {
    // Existence is checked by reading: it refuses the same cases `get` refuses,
    // with the same message, and it means a book that vanished between the check
    // and the write cannot be silently created by this call.
    await this.read(name)

    const resolved = resolveUidCollisions(entries)
    const stored: Record<string, unknown> = {}
    resolved.forEach((entry, index) => {
      const row = fromWorldbookEntry(entry, index)
      stored[String(row['uid'])] = row
    })

    const path = fileFor(this.dir, name, '.json')
    const temporary = `${path}.${String(process.pid)}.tmp`
    await writeFile(temporary, JSON.stringify({ entries: stored }, null, 2), 'utf8')
    await rename(temporary, path)

    return this.get(name)
  }

  /**
   * Write a book that does not exist yet.
   *
   * Separate from {@link replace}, which refuses a name with no file behind it.
   * The two callers want opposite guarantees: an edit must not create, and a
   * materialisation must not overwrite. Collapsing them into an upsert would
   * make each one able to do the other's damage silently.
   * @param name - the book's name, used verbatim as the filename.
   * @param entries - the whole book.
   * @returns the bytes written, so a caller can hash exactly what landed.
   * @throws {Error} when a book of that name already exists.
   */
  async create(name: string, entries: readonly PartialWorldbookEntry[]): Promise<string> {
    const path = fileFor(this.dir, name, '.json')
    if (existsSync(path)) throw invalid(`world book "${name}" already exists`)

    const resolved = resolveUidCollisions(entries)
    const stored: Record<string, unknown> = {}
    resolved.forEach((entry, index) => {
      const row = fromWorldbookEntry(entry, index)
      stored[String(row['uid'])] = row
    })

    const text = JSON.stringify({ entries: stored }, null, 2)
    await mkdir(this.dir, { recursive: true })
    const temporary = `${path}.${String(process.pid)}.tmp`
    await writeFile(temporary, text, 'utf8')
    // `rename` over a path checked absent above: two materialisations racing for
    // one name would both pass the check, and the loser's book would vanish
    // without a word. The check narrows the window; the binding table is what
    // actually closes it, by never reusing a name it did not record.
    await rename(temporary, path)
    return text
  }

  // —— family④: lorebook / worldbook ——
  /**
   * Delete a book's file.
   *
   * **Answers `false` for a name with no file rather than throwing**, which is
   * upstream's own shape: `deleteWorldInfo` returns `false` when the name is not
   * in `world_names` (`world-info.js:4235`), and both card-facing members over
   * this (`deleteWorldbook`, `deleteLorebook`) are declared `Promise<boolean>`.
   * A read here refuses with `not-found` because a caller asking for contents
   * has to tell "no such book" from "an empty one"; a delete has no such
   * distinction to lose — the post-state is the same either way.
   *
   * No temporary file and no atomic dance, unlike {@link replace}: there is no
   * half-deleted state to be caught in. The only thing that can go wrong is the
   * unlink failing, and that is reported as itself.
   *
   * Bindings are **not** touched. Which of them a caller then repairs is a
   * policy decision, and the one place with the standing to make it is the
   * handler that knows why the delete was asked for — see `worldbook.delete`.
   * @param name - the book's name, used verbatim as the filename.
   * @returns whether a file was there to remove.
   */
  async remove(name: string): Promise<boolean> {
    // `fileFor` for the containment guard, exactly as every other arm: a name
    // is used verbatim, so the one thing that must not be verbatim is a name
    // that climbs out of the directory.
    const path = fileFor(this.dir, name, '.json')
    if (!existsSync(path)) return false
    await unlink(path)
    return true
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
  /** The character's own entries, already normalized. */
  entries: LorebookEntry[]
  /** What {@link entries} came from. */
  source: 'named' | 'embedded' | 'none'
  /** The character's book name, for attribution on each of its entries. */
  world: string
  /**
   * Books the user bound to this character **through the host**, on top of the
   * card's own binding.
   *
   * Upstream's `world_info.charLore[<file name>].extraBooks`, folded into the
   * same search as the primary binding (`getCharacterLore`,
   * `world-info.js:4363`: `worldsToSearch` is the card's `extensions.world`
   * **plus** the stored extras, one Set). Each book keeps its own name here for
   * the same reason the global list does — `getwi(name, …)` matches on it — and
   * in binding order, which is the order the user chose.
   *
   * This is a **second channel that is not the embedded/named pair**: the
   * never-combine ruling above governs what the *card itself* contributes, and
   * stays absolute. An extra book is the user naming a book for this character
   * in this installation — the same kind of act as a global selection, just
   * scoped to one character — and upstream combines it with the primary
   * exactly as explicitly.
   */
  additional: { world: string, entries: LorebookEntry[] }[]
  /**
   * Globally selected books, which apply to every character.
   *
   * A **third source, added to** the character's rather than chosen between —
   * unlike the embedded/named pair. Upstream assembles
   * `[...chatLore, ...personaLore, ...characterLore, ...globalLore]`
   * (`world-info.js:4478`), so a globally selected book reaches every card.
   *
   * Kept as its own list rather than merged into {@link entries} because each
   * book attributes its entries to its own name, and `getwi(name, …)` matches on
   * that name. Flattening here would need one `world` for entries from several
   * books.
   */
  global: { world: string, entries: LorebookEntry[] }[]
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
 * 4. **Plus the books the user bound through the host.** `extraBooks` —
 *    upstream's `world_info.charLore[<file name>].extraBooks` — join the
 *    primary in one search set (`world-info.js:4376`), after it, in stored
 *    order. Rules 1–3 still govern the primary alone; an extra book is the
 *    user's own act, not a second reading of the card.
 *
 * @param card - the character being played.
 * @param store - the named books, when the host has them.
 * @param globalSelect - the globally selected book names.
 * @param materialised - the named book this host materialised from the card's
 *   embedded copy, when it did; wins over the card's own binding.
 * @param extraBooks - the character's additional bindings, in stored order.
 * @returns the chosen entries and where they came from.
 */
export async function resolveCardWorldbook(
  card: CharacterCard | undefined,
  store: WorldbookStore | undefined,
  globalSelect: readonly string[] = [],
  materialised?: string,
  extraBooks: readonly string[] = [],
): Promise<ResolvedWorldbook> {
  const fallbackName = card?.data.name ?? 'character book'
  // The materialised binding wins over the card's own `extensions.world`: it is
  // the book this host actually wrote, and when a wanted name collided the two
  // deliberately differ. Absent, the card's binding stands.
  const bound = materialised ?? charWorldbookNames(card).primary

  // The globally selected books, read once and shared by every branch below.
  const global: { world: string, entries: LorebookEntry[] }[] = []
  if (store !== undefined) {
    for (const name of globalSelect) {
      try {
        const book = await store.read(name)
        global.push({ world: name, entries: Object.values(book.entries) })
      } catch {
        // A selected book that no longer exists is skipped, not fatal. Upstream
        // does the same: `loadWorldInfo` returning nothing yields no entries and
        // a console note.
      }
    }
  }

  // The additional bindings, read once per chat open like every other source.
  // Upstream builds one Set with the primary, so a name bound as an extra that
  // *is* the primary contributes nothing twice; the same Set is reproduced by
  // the seen-list below, first occurrence winning.
  const additional: { world: string, entries: LorebookEntry[] }[] = []
  const seen = new Set<string>(bound !== null ? [bound] : [])
  for (const name of extraBooks) {
    if (seen.has(name)) continue
    seen.add(name)
    // The per-book guard upstream applies inside `getCharacterLore`
    // (`world-info.js:4387`): a book already active globally is skipped from
    // the character's search — "already activated in global world info!" —
    // whether it arrived as the primary binding or as an extra one.
    if (globalSelect.includes(name)) continue
    if (store === undefined) continue
    try {
      const book = await store.read(name)
      additional.push({ world: name, entries: Object.values(book.entries) })
    } catch {
      // A dangling extra — bound, then the file deleted. Upstream's loop
      // `continue`s on a failed `loadWorldInfo`; so does this. The binding
      // itself is still reported by `worldbook.charNames`.
    }
  }

  // Upstream's dedup, and it is not optional: `world-info.js:4387` skips a
  // character's book when it is *already* active globally, with the comment
  // "is already activated in global world info! Skipping...". Without it the one
  // card that binds a globally selected book gets every entry of it twice —
  // which is the duplication failure this module already exists to avoid, in a
  // second place.
  if (bound !== null && globalSelect.includes(bound)) {
    return { entries: [], source: 'none', world: bound, additional, global }
  }

  if (bound !== null && store !== undefined) {
    try {
      const book = await store.read(bound)
      return { entries: Object.values(book.entries), source: 'named', world: bound, additional, global }
    } catch {
      // A binding with no file behind it, or a file this build cannot parse.
      // Falls through to the embedded book rather than refusing: rule 2 exists
      // precisely for this card, and the corpus has two of them.
    }
  }

  // **No embedded fallback.** SillyTavern's assembly layer reads one
  // character-book channel — the bound name — and reaches the embedded book
  // only after it has been materialised into a named book. Reading it here was
  // a second channel with no upstream counterpart, and the duplication it
  // produced (1122 of 2246 entries) is what the old "choose one" rule existed
  // to paper over. Materialisation happens on the import and open paths, before
  // this runs; by the time resolution asks, an embedded book is already a named
  // one. See `materialise.ts` and `notes/packages/iris-app-service/EMBEDDED-BOOK-MATERIALISATION.md`.
  return { entries: [], source: 'none', world: fallbackName, additional, global }
}

/**
 * Report which book one card's world info comes from, for a panel to show.
 *
 * **A report of {@link resolveCardWorldbook}'s choice, not a second choice.**
 * The one line that decides *which name* is the same line and in the same
 * order — `materialised ?? charWorldbookNames(card).primary` — so the two
 * cannot name different books. What this adds is only what a screen needs and
 * a prompt does not: how many entries, and whether the name on screen is the
 * one written on the card.
 *
 * It deliberately does **not** reproduce the two other things resolution does.
 * It does not read the global selection, so it never answers `none` for the
 * dedup case (a card bound to a globally selected book contributes nothing
 * *as a character book* there, but the book is still what the card's world info
 * is, and telling a reader "none" would be answering a question about
 * assembly with a sentence about ownership). And it does not read the extra
 * bindings, which the panel edits and shows separately.
 *
 * The `embedded` case is the one resolution has no branch for, and that is not
 * a disagreement: materialisation runs on the import and open paths, so by the
 * time a prompt is assembled an embedded book has already become a named one.
 * A card that has never been opened on this host has not been through it yet,
 * and this is the reader looking at exactly that card — 140 entries the card
 * plainly carries, no file yet, and previously nothing on screen to say so.
 *
 * The embedded count is `character_book.entries.length`, the same expression
 * `LibraryStore.summarize` uses for `CharacterSummary.bookEntryCount`, so the
 * count in this panel and the count on the character page are one derivation
 * read twice rather than two that can drift.
 * @param card - the character being played, or undefined when none is open.
 * @param store - the named books, when the host has them.
 * @param materialised - the name this host materialised for the card, if any.
 * @returns the book, its size, and where the count came from.
 */
export async function cardWorldbookView(
  card: CharacterCard | undefined,
  store: WorldbookStore | undefined,
  materialised?: string,
): Promise<CardWorldbookView> {
  const own = charWorldbookNames(card).primary
  const bound = materialised ?? own
  const embedded = card?.data.character_book
  // True only when this host minted a name the card does not carry. A
  // materialisation that got the name it wanted is invisible to the reader and
  // should stay that way; the flag exists for the collision case, which is the
  // one that makes a panel look wrong.
  const minted = materialised !== undefined && materialised !== own

  if (bound !== null && store !== undefined) {
    try {
      const book = await store.read(bound)
      return {
        name: bound,
        source: 'named',
        entryCount: Object.keys(book.entries).length,
        materialised: minted,
      }
    } catch {
      // A binding with no file behind it, or a file this build cannot parse.
      // Falls through to the embedded copy, which is what the card still
      // plainly contains — and what resolution's rule 2 was written for.
    }
  }

  if (embedded !== undefined) {
    // The name stays whatever the card asked for even though no file carries
    // it: "bound to X, and X is not on disk yet" is the state, and blanking the
    // name would hide the half a reader needs to go looking.
    return { name: bound, source: 'embedded', entryCount: embedded.entries.length, materialised: minted }
  }

  return { name: null, source: 'none', entryCount: 0, materialised: false }
}

/** Sentinel for "the book could not be read", kept apart from "it is empty". */
const MISSING: WorldbookEntryDigest[] = []

/**
 * One book's entries, digested, or {@link MISSING} when it cannot be read.
 *
 * The sentinel is compared by identity, so an empty book and an unreadable one
 * are two answers rather than one — which is the whole distinction the
 * `missing` source exists to carry.
 * @param store - the named books, when the host has them.
 * @param name - the book's name, verbatim.
 * @returns the digests, or the sentinel.
 */
async function digestOf(
  store: WorldbookStore | undefined,
  name: string,
): Promise<WorldbookEntryDigest[]> {
  if (store === undefined) return MISSING
  try {
    return (await store.get(name)).map(toEntryDigest)
  } catch {
    return MISSING
  }
}

/**
 * Every book one card involves, entry by entry, with the content left behind.
 *
 * **A second reading of {@link cardWorldbookView}, not a second resolution.**
 * Which book is the card's own is decided by that function and by nothing here,
 * so the character page and the world book panel cannot name different books
 * for one card. What this adds is the entries — and only the part of an entry a
 * listing shows (`toEntryDigest`). Measured over the operator's own profile,
 * whose 11 book-carrying cards come to **841 entries**: the largest card's book
 * (140 entries) is 23 KB through this shape and 341 KB through `worldbook.get`,
 * and the biggest of them (153 entries) is 20 KB against 1.13 MB. Sending
 * `content` would put that on the wire for text a listing never shows.
 *
 * **Three shapes a book can be in, and all three are listed.** A file it read;
 * the card's embedded `character_book`, which is where a card nobody has opened
 * on this host still sits; and a *bound name with nothing behind it* — 2 of the
 * corpus's 18 bindings — which is listed as `missing` rather than dropped,
 * because a binding that activates nothing is otherwise indistinguishable from
 * a book with no entries and only one of those is broken.
 *
 * The extra bindings follow the card's own book in stored order, which is the
 * order the user made them, and a name that is already the card's own book is
 * not listed twice — the same first-occurrence rule
 * {@link resolveCardWorldbook} applies when it builds one search set.
 * `globalSelect` is deliberately not read: a globally selected book applies to
 * every character, and listing it under one card would report an
 * installation-wide setting as a property of that card.
 * @param card - the character whose page is open.
 * @param store - the named books, when the host has them.
 * @param materialised - the name this host materialised for the card, if any.
 * @param extraBooks - the character's additional bindings, in stored order.
 * @returns the card's books, its own first.
 */
export async function cardWorldbookDigest(
  card: CharacterCard | undefined,
  store: WorldbookStore | undefined,
  materialised?: string,
  extraBooks: readonly string[] = [],
): Promise<CardBookDigest[]> {
  const view = await cardWorldbookView(card, store, materialised)
  const books: CardBookDigest[] = []

  if (view.source === 'named' && view.name !== null) {
    // Read again rather than counted from the view: the view carries a count,
    // and a listing needs the rows. The file was readable a moment ago, so the
    // sentinel here is the race — deleted between the two reads — and it is
    // reported as the broken binding it has just become.
    const entries = await digestOf(store, view.name)
    books.push({
      name: view.name,
      source: entries === MISSING ? 'missing' : 'named',
      role: 'card',
      // Omitted rather than false: it is the reason a reader sees a name that is
      // not the one on their card, and false is the ordinary case.
      ...view.materialised ? { materialised: true } : {},
      entries: entries === MISSING ? [] : entries,
    })
  } else if (view.source === 'embedded' && view.name !== null) {
    /*
     * The card's own book, converted the way materialisation converts it —
     * `fromCharacterBook` then `toWorldbookEntry`, the same two calls in the
     * same order (`materialise.ts`). A card book is the V2 spec's shape, not a
     * SillyTavern book file's, and reading it as though it were the latter
     * gives every entry a default position and no keys.
     */
    const embedded = card?.data.character_book
    books.push({
      name: view.name,
      source: 'embedded',
      role: 'card',
      ...view.materialised ? { materialised: true } : {},
      entries: embedded === undefined
        ? []
        : Object.values(fromCharacterBook(embedded).entries).map(toWorldbookEntry).map(toEntryDigest),
    })
  } else {
    /*
     * `source: 'none'` covers two states this page has to keep apart: a card
     * that binds nothing and embeds nothing — no book, no row — and a card whose
     * binding names a book that is not there, which `cardWorldbookView` reports
     * as `none` with the name dropped. The binding is still a fact about the
     * card, so it is read again here and listed as missing.
     */
    const own = materialised ?? charWorldbookNames(card).primary
    if (own !== null) {
      books.push({ name: own, source: 'missing', role: 'card', entries: [] })
    }
  }

  const listed = new Set(books.map(book => book.name))
  for (const name of extraBooks) {
    if (listed.has(name)) continue
    listed.add(name)
    const entries = await digestOf(store, name)
    // A dangling extra — bound, then the file deleted or renamed, or bound on a
    // host that keeps no books at all. Reported as the broken binding it is;
    // upstream's scan simply `continue`s past it.
    const missing = entries === MISSING
    books.push({
      name,
      source: missing ? 'missing' : 'named',
      role: 'additional',
      entries: missing ? [] : entries,
    })
  }

  return books
}

/**
 * Turn one card-facing entry back into the shape a book file stores.
 *
 * The inverse of {@link toWorldbookEntry}, and **deliberately not its exact
 * inverse** — upstream's is not either, and copying that faithfully is the
 * point. Two asymmetries a caller can be bitten by, both upstream's:
 *
 * 1. **`constant` defaults to `true` when `strategy` is absent.** Reading maps
 *    `constant: false` to `'selective'`, but writing a partial that omits
 *    `strategy` produces `constant: true` — an **always-on** entry. So
 *    `updateWorldbookWith(name, book => book.map(e => ({ uid: e.uid })))` does
 *    not "keep everything and change nothing": it turns every entry in the book
 *    constant. This is copied rather than corrected, because a card may depend
 *    on it and correcting it is what would break them.
 * 2. **`useProbability` defaults to `true`.** Reading resolves it away
 *    (`useProbability ? probability : 100`), so a round trip stores the flag
 *    differently while leaving the effective probability the same. Since the
 *    view began reporting the raw flag, a caller may also send `false`
 *    explicitly — that is taken verbatim; only the *absent* case is upstream's
 *    `true`.
 *
 * Anyone reaching to "fix" either of these should note that both are load-
 * bearing compatibility, not oversights — and that this paragraph is the thing
 * to delete first, so that deleting it is a visible decision.
 * @param entry - a partial card-facing entry; only `uid` is required.
 * @param displayIndex - the entry's position in the array being written.
 * @returns the stored shape, with every field upstream would have filled in.
 */
export function fromWorldbookEntry(
  entry: PartialWorldbookEntry,
  displayIndex: number,
): Record<string, unknown> {
  const type = entry.strategy?.type
  const logic = entry.strategy?.keys_secondary?.logic ?? 'and_any'
  const scanDepth = entry.strategy?.scan_depth

  return {
    ...DEFAULT_IMPLICIT_KEYS,
    uid: entry.uid,
    displayIndex,
    comment: entry.name ?? '',
    disable: !(entry.enabled ?? true),

    // See asymmetry 1 above: absent `strategy` means constant, not selective.
    constant: type !== undefined ? type === 'constant' : true,
    selective: type === 'selective',
    vectorized: type === 'vectorized',
    key: (entry.strategy?.keys ?? []).map(String),
    selectiveLogic: SELECTIVE_LOGIC[logic],
    keysecondary: (entry.strategy?.keys_secondary?.keys ?? []).map(String),
    scanDepth: scanDepth === 'same_as_global' ? null : scanDepth ?? null,

    position: POSITION_CODES[entry.position?.type ?? 'at_depth'],
    role: ROLE_CODES[entry.position?.role ?? 'system'],
    depth: entry.position?.depth ?? 4,
    order: entry.position?.order ?? 100,

    content: entry.content ?? '',

    // See asymmetry 2 above: absent stays `true` — but a caller that read the
    // view (which now reports the raw flag) and sends `useProbability: false`
    // is putting a stored flag back, and that answer is taken verbatim.
    useProbability: entry.useProbability ?? true,
    probability: entry.probability ?? 100,

    // Kept in the stored row: the outlet macro answers from the scan's bucket,
    // and an outlet name lost in a materialisation is an outlet that can never
    // fire again.
    outletName: entry.outletName ?? '',

    excludeRecursion: entry.recursion?.prevent_incoming ?? false,
    preventRecursion: entry.recursion?.prevent_outgoing ?? false,
    delayUntilRecursion: entry.recursion?.delay_until ?? false,
    sticky: entry.effect?.sticky ?? null,
    cooldown: entry.effect?.cooldown ?? null,
    delay: entry.effect?.delay ?? null,

    // The stored shape's remaining fields, each at the same default its read
    // side resolves an absent field to — so a caller that never sends them
    // writes a row indistinguishable from the one this wrote before they
    // existed, and a caller that read a whole book and sends it back whole
    // loses none of them.
    ignoreBudget: entry.ignoreBudget ?? false,
    automationId: entry.automationId ?? '',
    useGroupScoring: entry.useGroupScoring ?? null,
    triggers: [...entry.triggers ?? []],
    characterFilter: entry.characterFilter !== undefined
      ? {
          isExclude: entry.characterFilter.isExclude,
          names: [...entry.characterFilter.names],
          tags: [...entry.characterFilter.tags],
        }
      : { isExclude: false, names: [], tags: [] },

    // The caller's own implicit keys win over the defaults spread above.
    ...pickImplicit(entry),
  }
}

/**
 * Give every entry a uid nothing else in the book claims.
 *
 * Upstream's algorithm, including its quadratic probe: an absent uid becomes a
 * random one below a million, and a collision advances by `i * i` modulo the
 * same bound. Reproduced rather than replaced by something simpler because the
 * uid is an entry's identity — a book written by this host and reopened in
 * SillyTavern has to agree about which entry is which.
 * @param entries - the entries about to be written, in order.
 * @returns the same entries with unique uids.
 */
export function resolveUidCollisions(entries: readonly PartialWorldbookEntry[]): PartialWorldbookEntry[] {
  const MAX_UID = 1_000_000
  const taken = new Set<number>()

  return entries.map((entry) => {
    let candidate = entry.uid ?? Math.floor(Math.random() * MAX_UID)
    let step = 1
    while (taken.has(candidate)) {
      candidate = (candidate + step * step) % MAX_UID
      step += 1
    }
    taken.add(candidate)
    return { ...entry, uid: candidate }
  })
}
