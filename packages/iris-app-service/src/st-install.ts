/**
 * Reading a user's SillyTavern installation, and never writing to it.
 *
 * A card can name a world book that did not travel with it. The book usually
 * exists — in the user's own SillyTavern install — so this reads it from there
 * rather than leaving the card seeded from its embedded copy.
 *
 * **Read-only, at file level.** Only `worlds/*.json` and `settings.json` are
 * opened. Nothing here calls SillyTavern, and nothing assumes it is stopped:
 * the install may be running and writing, so a half-written file is an ordinary
 * outcome and is reported as "could not fetch this time", never thrown.
 *
 * @module @iris/app-service/st-install
 */

import { readdir, readFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'

/**
 * SillyTavern's own filename rule, mirrored.
 *
 * Their server writes ``sanitize(`${name}.json`)`` through the npm
 * `sanitize-filename` package (`src/endpoints/worldinfo.js:24`), so a book's
 * file *is* its name minus only what that package strips.
 *
 * **This host's own `toId` must not be used to find these files, and the reason
 * is stronger than "it spells things differently".** Measured against the 18
 * books in the reference install: `toId(name) === name` for **5**, and differs
 * for **13**. Worse than a miss, some of those differences resolve to a
 * *different book*: `toId` strips a trailing extension, so `创世回廊1.3`
 * becomes `创世回廊1` and `命定之诗与黄昏之歌v3.0.4` becomes
 * `…v3.0` — version numbers read as file extensions. A lookup built on it would
 * silently fetch the wrong book for any name ending in a dotted version.
 *
 * `toId` is right for *our* filenames, where it is the only writer and the
 * transform is applied consistently. It is wrong as a reader of someone else's
 * directory, where the names were produced by a different rule.
 * @param name - the book's name, as a card or setting spells it.
 * @returns the filename SillyTavern would have written it under.
 */
export function stFileName(name: string): string {
  // The package's own steps, in its order: illegal characters, control
  // characters, reserved device names, then trailing dots and spaces, then a
  // 255-byte truncation. Replacement is the empty string, as SillyTavern calls
  // it with no options.
  const illegal = /[/?<>\\:*|"]/gu
  // Written as escapes rather than as the characters themselves: a literal
  // control character in source is invisible in review and makes the whole
  // file read as binary to every tool that looks at it.
  const control = /[\u0000-\u001f\u0080-\u009f]/gu
  const reserved = /^\.+$/u
  const windowsReserved = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/iu
  const trailing = /[. ]+$/u

  let cleaned = `${name}.json`
    .replace(illegal, '')
    .replace(control, '')
    .replace(reserved, '')
    .replace(trailing, '')
  if (windowsReserved.test(cleaned)) cleaned = ''

  // Bytes, not characters: the limit is a filesystem limit, and these names are
  // largely CJK, where one character is three bytes.
  const bytes = Buffer.from(cleaned, 'utf8')
  return bytes.length <= 255 ? cleaned : Buffer.from(bytes.subarray(0, 255)).toString('utf8')
}

/** Why a book could not be fetched. Each needs a different sentence. */
export type FetchFailure =
  /** No install is configured, so nothing was looked for. */
  | 'not-configured'
  /** The install was searched and holds no such book. */
  | 'absent'
  /** The book is there and this read did not get it — possibly a concurrent write. */
  | 'unreadable'

/** What a fetch produced. */
export type FetchResult =
  | { found: true, book: unknown }
  | { found: false, why: FetchFailure }

/**
 * A user's SillyTavern profile directory, opened read-only.
 *
 * `dir` points at the profile itself — `…/data/<user>` — not at the install
 * root. Users with several profiles pick one; enumerating them is deliberately
 * not designed, because choosing on the user's behalf is the part that would be
 * wrong.
 */
export class StInstall {
  readonly #dir: string | undefined

  /**
   * @param dir - the profile directory, or undefined when none is configured.
   */
  constructor(dir?: string) {
    this.#dir = dir
  }

  /** Whether an install was configured at all. */
  get configured(): boolean {
    return this.#dir !== undefined
  }

  /**
   * One world book, by the name a card or setting spells.
   *
   * Matched by SillyTavern's filename rule first, then by scanning the
   * directory — the scan is the fallback for a name whose file was written by
   * an older or different rule, and it costs one `readdir` on a path that runs
   * when a binding fails to resolve.
   * @param name - the book's name.
   * @returns the parsed book, or which kind of nothing this was.
   */
  async book(name: string): Promise<FetchResult> {
    if (this.#dir === undefined) return { found: false, why: 'not-configured' }
    if (name === '') return { found: false, why: 'absent' }

    const worlds = join(this.#dir, 'worlds')
    let entries: string[]
    try {
      entries = (await readdir(worlds)).filter(entry => entry.endsWith('.json'))
    } catch {
      // No `worlds` directory: the path is configured but is not a profile, or
      // the user has never made a book. Either way the book is not there.
      return { found: false, why: 'absent' }
    }

    // **One criterion, not two.** Upstream has two and they disagree:
    // `world_names` is built from raw directory basenames
    // (`settings.js:253-257`) while `/get` sanitizes the requested name again,
    // so a book whose name contains an illegal character is absent from the
    // list yet readable by name. That inconsistency is not worth copying — we
    // have no `world_names` layer for it to be inconsistent with. Existence and
    // reading both go through the same rule.
    const wanted = stFileName(name)
    // A name that sanitizes to nothing — `con`, `nul`, `lpt1` — has no file to
    // find rather than matching some other one.
    if (wanted === '.json' || wanted === '') return { found: false, why: 'absent' }
    if (!entries.includes(wanted)) return { found: false, why: 'absent' }
    const file = wanted

    try {
      return { found: true, book: JSON.parse(await readFile(join(worlds, file), 'utf8')) as unknown }
    } catch {
      // Present but not readable *this time*. Distinct from absent on purpose:
      // SillyTavern may be writing it right now, and the next open may well
      // succeed — telling the user it is missing would send them looking for a
      // book they have.
      return { found: false, why: 'unreadable' }
    }
  }

  /**
   * The books SillyTavern currently has globally selected.
   *
   * **The path is `world_info_settings.world_info.globalSelect`, and the
   * nesting matters.** A top-level `world_info` key does not exist; reading it
   * yields `undefined`, and a `?? []` fallback turns that into a clean empty
   * selection — a missing key wearing the face of "the user selected nothing".
   * The two are different facts, so an unreadable or absent setting is reported
   * as `undefined` here rather than as an empty list.
   * @returns the selected names, or undefined when the setting could not be read.
   */
  async globalSelect(): Promise<string[] | undefined> {
    if (this.#dir === undefined) return undefined
    try {
      const parsed: unknown = JSON.parse(await readFile(join(this.#dir, 'settings.json'), 'utf8'))
      const settings = (parsed as { world_info_settings?: { world_info?: { globalSelect?: unknown } } })
        .world_info_settings?.world_info?.globalSelect
      if (!Array.isArray(settings)) return undefined
      return settings.filter((name): name is string => typeof name === 'string')
    } catch {
      return undefined
    }
  }
}

/**
 * Refuse an install path that overlaps this host's own data directory.
 *
 * Checked at construction rather than at first read: the whole premise is that
 * we never write to the user's install, and the way that premise breaks is the
 * two directories being the same one — after which our ordinary writes land in
 * their library. A failure at startup is recoverable; discovering it later is
 * not.
 * @param stDir - the configured SillyTavern profile directory.
 * @param dataDir - this host's own data directory.
 * @returns the reason to refuse, or undefined when the pair is safe.
 */
export function refuseOverlappingInstall(stDir: string, dataDir: string): string | undefined {
  const st = resolve(stDir)
  const ours = resolve(dataDir)
  if (st === ours || st.startsWith(ours + sep) || ours.startsWith(st + sep)) {
    return `the SillyTavern directory "${stDir}" overlaps Iris's own data directory "${dataDir}";`
      + ' Iris reads that install and must never write to it, which it cannot promise if they are the same tree'
  }
  return undefined
}
