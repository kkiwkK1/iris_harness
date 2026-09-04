/**
 * Identity and the files behind it.
 *
 * Every id in the protocol reaches this process from a browser, and every id
 * here becomes a path. That makes this module a security boundary, not a
 * formatting helper: `chatId` is checked against a whitelist pattern *and* the
 * resolved path is checked to still be inside its directory, because one guard
 * alone is one bug away from `../../`.
 *
 * @module @iris/app-service/paths
 */

import { join, resolve, sep } from 'node:path'

import { invalid } from './errors.ts'

/**
 * Characters no id may contain, whatever else it holds.
 *
 * A blacklist, not a whitelist, and that is a deliberate reversal. The
 * whitelist this replaced (`\p{L}\p{N}._-`) rejected **every one of the 31 real
 * SillyTavern chat filenames on this machine and 4 of the 19 cards** — a chat is
 * named `Aria - 2026-01-18@05h53m41s311ms`, and a card `【Sgw】又看一集`. Pointing
 * Iris at a real install showed an empty library, which is the opposite of the
 * interoperability the storage layout was chosen for.
 *
 * What is listed here is what a filesystem or a path parser actually treats
 * specially. Measured against the corpus: the characters that caused those
 * rejections were space, `@`, `#` and fullwidth CJK punctuation — `：` is U+FF1A,
 * a letterlike character Windows stores happily, and a rule written from memory
 * as "no colons" would have refused it too.
 */
const FORBIDDEN = /[/\\:*?"<>|]|[\p{Cc}\p{Cf}]/u

/** Windows reserves these device names in every directory, extension or not. */
const RESERVED = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i

/**
 * Whether an id may be turned into a filename.
 *
 * The containment check in {@link fileFor} is the guard that actually stops a
 * traversal; this rejects the shapes that are wrong before a path is even built,
 * so a bad id is refused with its own name rather than as a path error.
 * @param id - the candidate, straight off the wire or off the disk.
 * @returns true when it names a file and nothing else.
 */
export function isSafeId(id: string): boolean {
  if (id.length === 0 || id.length > 120) return false
  if (FORBIDDEN.test(id)) return false
  // `.` and `..` are directories, not names; a leading or trailing dot or space
  // is silently stripped by Windows, so the id on disk would not be the id asked
  // for — and two different ids could then name one file.
  if (id === '.' || id === '..') return false
  if (/^[.\s]|[.\s]$/u.test(id)) return false
  if (RESERVED.test(id.split('.')[0] ?? '')) return false
  return true
}

/**
 * Turn a human name into an id.
 * @param name - a character name, a filename, or anything else user-authored.
 * @returns a safe id, never empty.
 */
export function toId(name: string): string {
  // Only a real trailing extension is stripped: a path-shaped name like
  // `../../etc/passwd` must keep its segments so the filter below can flatten
  // them, rather than being cut back to `..` and silently becoming `unnamed`.
  const stem = name.replace(/\.[^./\\]+$/, '')
  const cleaned = stem
    .normalize('NFC')
    .replace(/[\p{Cc}\p{Cf}]/gu, '')
    .replace(/[\s]+/gu, '-')
    .replace(/[^\p{L}\p{N}._-]/gu, '')
    .replace(/^[.\-]+|[.\-]+$/g, '')
    .slice(0, 100)
  if (cleaned.length === 0 || !isSafeId(cleaned)) return 'unnamed'
  return cleaned
}

/**
 * Derive an id nothing has claimed yet.
 * @param base - the preferred id.
 * @param taken - reports whether an id is in use.
 * @returns `base`, or `base-2`, `base-3`, … until one is free.
 */
export function uniqueId(base: string, taken: (id: string) => boolean): string {
  if (!taken(base)) return base
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base}-${String(suffix)}`
    if (!taken(candidate)) return candidate
  }
}

/**
 * Resolve one id to a file inside a directory, refusing anything that escapes.
 * @param dir - the directory that owns the file.
 * @param id - the id from the request.
 * @param extension - the file extension, dot included.
 * @returns the absolute path.
 * @throws {AppError} `invalid-request` when the id would leave `dir`.
 */
/**
 * Where copies taken before an irreversible change live.
 *
 * Beside `chats/` under the same profile, so a backup travels with the profile
 * it protects and a user who moves their data does not leave it behind.
 * @param chatsDir - the profile’s chat directory.
 * @returns the backup directory, which may not exist yet.
 */
export function backupsDir(chatsDir: string): string {
  return resolve(chatsDir, '..', 'backups')
}

export function fileFor(dir: string, id: string, extension: string): string {
  if (!isSafeId(id)) throw invalid(`"${id}" is not a valid identifier`)
  const root = resolve(dir)
  const path = resolve(root, `${id}${extension}`)
  // Belt and braces: the pattern above already forbids separators, and this
  // catches whatever the pattern one day fails to.
  if (path !== root && !path.startsWith(root + sep)) {
    throw invalid(`"${id}" is not a valid identifier`)
  }
  return path
}

/**
 * The default profile's name.
 *
 * SillyTavern's own layout is `data/default-user/…`, and the local card corpus
 * lives at exactly that path. Matching it means a user can point `dataDir` at an
 * existing SillyTavern `data/` folder and find their characters already there.
 */
export const DEFAULT_PROFILE = 'default-user'

/** Every path one profile's data lives at. */
export interface ProfilePaths {
  /** The profile's own directory. */
  root: string
  /** Card files. */
  characters: string
  /**
   * Named world books, each in its own file.
   *
   * SillyTavern's own directory name, for the same reason `characters` is:
   * pointing `dataDir` at a real install finds the books its cards are already
   * bound to. 18 of 19 corpus cards bind one.
   */
  worlds: string
  /** Conversation files. */
  chats: string
  /** Generation settings, global and per chat. */
  settings: string
  /** The user's decisions about card scripts, including document grants. */
  scriptPolicy: string
  /** What cards have stored under `extension_settings`. */
  extensionSettings: string
  /**
   * What card scripts have stored in their own variable scope.
   *
   * Its own file, beside the installation rather than inside the card, which is
   * where SillyTavern puts it. `script-variables.ts` carries the measurement and
   * the reason.
   */
  scriptVariables: string
  /**
   * Button tables a script rewrote at runtime.
   *
   * Beside the installation rather than in the card, for the same reason
   * `scriptVariables` is — see `script-buttons.ts`. Upstream's writer edits the
   * card file through a deep watcher; this host does not.
   */
  scriptButtons: string
  /** Which named book each card's embedded book was materialised into. */
  worldbookBindings: string
  /** Key–value storage cards share across this profile. */
  cardStorage: string
  /**
   * Remote script bundles the host has fetched on a card's behalf.
   *
   * Not profile-specific in principle — the same jsDelivr URL is the same bytes
   * for everyone — but kept inside the profile anyway, so deleting a profile
   * takes its whole footprint with it and leaves nothing the user cannot find.
   */
  scriptBundles: string
  /**
   * Saved connections.
   *
   * Its own file, not a section of `settings.json`: settings are what a chat is
   * using now, these are the sets the user assembled. Clearing one should not
   * empty the other.
   */
  connections: string
  /**
   * Preset files, one per preset.
   *
   * Upstream's own directory name for them is `OpenAI Settings`, which is
   * both a misnomer here (they are Chat Completion prompt presets) and a name
   * that collides with this host's `settings.json` in a reader's mind. The
   * files inside keep the exact names they had there, though — that is what an
   * import preserves.
   */
  presets: string
}

/**
 * Derive every storage path for one profile.
 *
 * The single place a `dataDir` becomes concrete paths. Multi-profile was a
 * founding decision, and keeping the derivation in one function is what makes
 * it one segment rather than a redesign — every store that grows later gets its
 * path from here, so no store can be the one that forgot.
 *
 * The profile name is validated exactly as a chat or character id is: it
 * reaches this process from configuration, becomes a directory, and an
 * unchecked `..` in it would put one profile's data inside another's.
 * @param dataDir - the root holding every profile.
 * @param profile - the profile's name.
 * @returns the paths that profile's stores use.
 * @throws {AppError} `invalid-request` when the name would escape `dataDir`.
 */
export function profilePaths(dataDir: string, profile: string = DEFAULT_PROFILE): ProfilePaths {
  // Reuses `fileFor`'s guard by asking it for the directory itself: the name has
  // to survive the same whitelist and the same containment check a chat id does.
  const root = fileFor(dataDir, profile, '')
  return {
    root,
    characters: join(root, 'characters'),
    worlds: join(root, 'worlds'),
    chats: join(root, 'chats'),
    settings: join(root, 'settings.json'),
    scriptPolicy: join(root, 'script-policy.json'),
    extensionSettings: join(root, 'extension-settings.json'),
    scriptVariables: join(root, 'script-variables.json'),
    scriptButtons: join(root, 'script-buttons.json'),
    worldbookBindings: join(root, 'worldbook-bindings.json'),
    cardStorage: join(root, 'card-storage.json'),
    scriptBundles: join(root, 'script-bundles'),
    connections: join(root, 'connections.json'),
    presets: join(root, 'presets'),
  }
}
