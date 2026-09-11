/**
 * The one way this package replaces a file, and the one way it sets a file it
 * could not read aside.
 *
 * **Why a module of its own.** Every store here wrote its file with a plain
 * `writeFile`, which truncates the target first and then streams the new bytes
 * into it: a crash, a power loss, a full disk or a kill between those two acts
 * leaves the file existing, shorter than it should be, and unparsable. On the
 * largest conversation in the local corpus — 677 floors, 19 MiB, rewritten
 * whole on every turn — that window is not theoretical, and what it destroys is
 * the only copy (`backups` is taken before *dangerous* operations, not before
 * an ordinary save). Upstream SillyTavern has never written this way: every
 * file it owns goes through `write-file-atomic`, including the per-turn chat
 * save (`src/util.js:1491` `tryWriteFileSync` → `writeFileAtomicSync`, called
 * from `src/endpoints/chats.js:466`) and the settings file
 * (`src/endpoints/settings.js:209`), 61 call sites in all.
 *
 * Iris already had the pattern hand-rolled in two places — `worldbooks.ts` and
 * `cache-trace.ts`, the latter's comment naming the former as its home — so
 * there were three behaviours in one package. There is now one.
 *
 * **What atomicity here does and does not buy.** `rename` over an existing path
 * is atomic on both filesystems this host runs on: POSIX `rename(2)` replaces,
 * and Node's Windows implementation asks for `MOVEFILE_REPLACE_EXISTING`, which
 * is why {@link atomicWriteFile} is the same call on both and why the suite
 * pins a rename-over-existing on whatever machine it runs on rather than
 * trusting the sentence. A reader therefore sees either every old byte or every
 * new one. It does **not** promise the new bytes have reached the platter: no
 * `fsync` is issued, deliberately, because the per-turn cost of one on a 19 MiB
 * file is the thing that would make people turn saving off, and the failure it
 * would close (the whole machine losing power inside the rename) leaves the old
 * file, not a truncated one.
 *
 * @module @iris/app-service/atomic
 */

import { randomBytes } from 'node:crypto'
import { existsSync, type Dirent } from 'node:fs'
import { readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

import { isPidAlive } from './host-lock.ts'

/**
 * Codes a Windows rename raises for a target another handle is holding.
 *
 * Not a guess: measured on this machine by racing two `atomicWriteFile` calls
 * at one path, which is the exact shape of two saves of one conversation
 * overlapping. The second rename came back `EPERM` — the replaced file is
 * briefly un-replaceable while the first rename's delete is pending — and the
 * write failed where a plain `writeFile` would have succeeded (by interleaving
 * two files' bytes, which is what this module exists to prevent, but it would
 * not have *thrown*). `EBUSY` and `EACCES` are the same condition reported
 * differently by different Windows versions and by an antivirus scanning the
 * new file, and `graceful-fs` — which upstream's `write-file-atomic` pulls in —
 * retries exactly this set for exactly this reason.
 *
 * `ENOENT` is here for a different, measured reason. The 2026-09-11 incident
 * this file's sibling `host-lock.ts` closes produced a failure triple on one
 * card call: `replaceWorldbook` lost a rename with `EPERM` (the other host held
 * the target open), then again, and the third attempt failed with
 * `ENOENT: rename '…\扣扣审判1.0.json.1664.tmp' -> '…\扣扣审判1.0.json'` — the
 * temporary was there when it was written and gone by rename time, unlinked by
 * the competing host's own failure cleanup. When two writers each tidy up their
 * temporaries, a rename can observe the directory entry in flux: a path that
 * existed when the write finished is reported absent in the window while the
 * other side's unlink settles. That window closes by itself, which is all a
 * bounded retry needs. The bound also bounds the cost of the hopeless case — a
 * temporary genuinely gone is gone for every attempt, and the last error is
 * thrown unchanged, still naming both paths.
 */
const RETRYABLE_RENAME_CODES = new Set(['EPERM', 'EBUSY', 'EACCES', 'ENOENT'])

/**
 * `rename`, waiting out a target another handle is holding — or a directory
 * entry another writer is still settling.
 *
 * Ten attempts with a doubling backoff — roughly half a second in total — after
 * which the failure is the caller's, because a rename still refused after that
 * is a permission problem rather than a race and no amount of waiting fixes it.
 * The atomicity is unaffected: every attempt is the same all-or-nothing
 * replace, and a retry only ever happens when none of them has taken effect.
 * @param from - the temporary.
 * @param to - the file being replaced.
 */
async function renameWithRetry(
  from: string,
  to: string,
  replace: AtomicWriteOptions['rename'] = rename,
  wait: AtomicWriteOptions['wait'] = ms => new Promise<void>(resolve => { setTimeout(resolve, ms) }),
): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await replace(from, to)
      return
    } catch (error: unknown) {
      const code = (error as { code?: string }).code
      if (attempt >= 9 || code === undefined || !RETRYABLE_RENAME_CODES.has(code)) throw error
      await wait(1 << attempt)
    }
  }
}

/**
 * The two platform calls a test needs to stand in for.
 *
 * The retry exists because of a Windows behaviour (`RETRYABLE_RENAME_CODES`),
 * and a test that provoked it by holding a handle open was green on Windows
 * and red on the Linux runner, where `rename` over an open file just succeeds
 * and the retry never ran. The mechanism is therefore tested through these
 * seams, on every platform alike; the Windows fact itself is recorded in the
 * comment above the code set, where it belongs, as a measurement.
 */
export interface AtomicWriteOptions {
  /** Stands in for `fs.rename`; production code never passes one. */
  rename?: (from: string, to: string) => Promise<void>
  /** Stands in for the backoff sleep; production code never passes one. */
  wait?: (ms: number) => Promise<void>
  /**
   * Permission bits the new file is created with — the one option here that is
   * not a test seam.
   *
   * Applied to the **temporary**, which is the only way to get them onto the
   * inode from its first byte: a `chmod` after the rename leaves a window in
   * which the file exists with the umask's bits, and for the one caller that
   * asks (`key-protection.ts`, `0o600` on the wrapped data key) that window is
   * the whole point of asking. Absent leaves it to the umask, which is what
   * every other store here wants.
   */
  mode?: number
}

/**
 * Replace a file's whole contents, or leave the previous contents standing.
 *
 * The bytes are written to a sibling temporary in the **same directory** — not
 * the OS temp folder — because `rename` is only atomic within one filesystem,
 * and a data directory on another volume than `%TEMP%` is the ordinary case on
 * a Windows machine with a second disk. The temporary's name carries the
 * process id and eight random bytes, so two hosts sharing one profile, and two
 * writers inside one host, never collide on it.
 *
 * A failure of the write unlinks the temporary before rethrowing, so a full
 * disk leaves no debris to be mistaken for a store's own file by the directory
 * scans several of these stores run. A failure of the *rename* does the same:
 * at that point the target is still whatever it was.
 * @param path - the file to replace.
 * @param data - the whole contents. A string is written as UTF-8, which is what
 *   every call site passed explicitly before; bytes are written as they are.
 * @throws whatever the underlying write or rename threw, after cleaning up.
 */
export async function atomicWriteFile(
  path: string,
  data: string | Uint8Array,
  options: AtomicWriteOptions = {},
): Promise<void> {
  const temporary = join(
    dirname(path),
    `${basename(path)}.${String(process.pid)}.${randomBytes(8).toString('hex')}.tmp`,
  )
  try {
    // Two overloads rather than one call with an optional encoding: passing
    // `'utf8'` alongside a `Uint8Array` is what the byte-writing call sites
    // (a card's PNG, `library.ts`) must never do, and the narrowing is what
    // makes that unexpressible here instead of a rule each caller remembers.
    const mode = options.mode === undefined ? {} : { mode: options.mode }
    if (typeof data === 'string') await writeFile(temporary, data, { encoding: 'utf8', ...mode })
    else await writeFile(temporary, data, mode)
    await renameWithRetry(temporary, path, options.rename, options.wait)
  } catch (error: unknown) {
    // Best-effort, and swallowed on purpose: the caller is already being told
    // the write failed, and a cleanup that throws over it would replace that
    // diagnosis with "ENOENT unlinking a temp file".
    await unlink(temporary).catch(() => {})
    throw error
  }
}

/**
 * The process id a temporary's name carries, or undefined when it is not one.
 *
 * Both shapes this package has ever written are claimed. The current one appends
 * `.<pid>.<16 hex>.tmp` ({@link atomicWriteFile}'s own spelling); the one before
 * it appended `.<pid>.tmp` alone — and `…\扣扣审判1.0.json.1664.tmp` from the
 * 2026-09-11 two-host incident is sitting in a real `worlds` directory in
 * exactly that shape. Anything else — a `stray.tmp`, a `.tmp` whose pid segment
 * carries hex letters and so was never a process id — parses as nobody's, and
 * nobody's debris is not this function's to remove.
 * @param name - a file name, not a path.
 * @returns the process id the name records, when it has one.
 */
function temporaryPid(name: string): number | undefined {
  const parsed = /^(?:.+)\.(\d+)(?:\.[0-9a-f]{16})?\.tmp$/u.exec(name)
  // `exec` answers `null` — not `undefined` — when the name does not match.
  if (parsed === null) return undefined
  const pid = Number(parsed[1])
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined
}

/** Options, injectable so a test never depends on which ids are running. */
export interface StaleTemporarySweepOptions {
  /** This process's id. Defaults to `process.pid`. */
  pid?: number
  /** The liveness probe. Defaults to {@link isPidAlive}. */
  isAlive?: (pid: number) => boolean
}

/**
 * Remove the stale temporaries this package's own writes left behind.
 *
 * **Why a sweep at all.** Every `atomicWriteFile` failure unlinks its own
 * temporary, and a crash that lands *between* the write and the rename is
 * rare — but a data directory outlives processes, and the temporaries a killed
 * host never got to clean up stay in it forever: in `worlds/`, in `chats/`,
 * beside every store's file. Nothing reads a `.tmp`, so the debris is invisible
 * until a directory listing or a backup has to step over it. Measured debris:
 * the two-host incident left `扣扣审判1.0.json.1664.tmp` in the real
 * `apps/iris/data/…/worlds` — pid 1664, a process that no longer existed when
 * the failure triple was read off the log.
 *
 * **The claim rule is the lock's own liveness probe, pointed at a filename.** A
 * temporary is removed when its recorded pid is this process's own (ids are
 * recycled: a leftover naming *our* id would fail the dead check and otherwise
 * sit forever), or when no process with that id is running. A temporary whose
 * pid is somebody else's *and* alive is left exactly where it is — under the
 * host lock a second host cannot hold this directory, but this sweep should
 * stay correct on its own terms, not borrow that guarantee.
 *
 * **Where it runs is what makes it safe.** The one caller is `apply`, right
 * after the host lock is taken and before a store is constructed — so nothing
 * in this process has a temporary in flight, and no other process legitimately
 * does either. The walk is recursive (a temporary lives beside its target, and
 * targets live four levels down), does not follow symlinks, and answers an
 * absent root with an empty list rather than an error: a first boot has no
 * profile to sweep.
 * @param root - the data directory to sweep, recursively.
 * @param options - the identity and probe, for tests.
 * @returns the absolute paths removed, in walk order.
 */
export async function sweepStaleTemporaries(
  root: string,
  options: StaleTemporarySweepOptions = {},
): Promise<string[]> {
  const ownPid = options.pid ?? process.pid
  const isAlive = options.isAlive ?? (pid => isPidAlive(pid))
  const removed: string[] = []

  const walk = async (dir: string): Promise<void> => {
    let entries: Dirent[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      // Absent or unreadable is nothing to sweep. A first boot has no profile
      // yet, and an unreadable subtree is not this call's diagnosis to make.
      return
    }
    for (const entry of entries) {
      const path = join(dir, entry.name)
      // `isDirectory` is false for a symlink to a directory, so a link out of
      // the tree is never followed; its target is not ours to walk.
      if (entry.isDirectory()) {
        await walk(path)
        continue
      }
      if (!entry.isFile()) continue
      const pid = temporaryPid(entry.name)
      if (pid === undefined || (pid !== ownPid && isAlive(pid))) continue
      // A failed unlink — a permission, a race — leaves the file for the next
      // boot rather than failing the boot over it.
      if (await unlink(path).then(() => true, () => false)) removed.push(path)
    }
  }

  await walk(root)
  return removed
}

/**
 * The name a file that could not be parsed is set aside under.
 *
 * Colons are what an ISO stamp and a Windows filename disagree about, and the
 * dot before the milliseconds is replaced for the same reason a directory scan
 * would otherwise read `…json.corrupt-2026-09-11T12-00-00` and `.123Z` as an
 * extension boundary. The stamp is UTC because the question a reader asks of it
 * is "which incident", not "what time was it here".
 * @param path - the file being set aside.
 * @param at - the moment, injectable so a test can pin the name.
 * @param label - what was wrong with it, in one word.
 * @returns the path to rename to.
 */
function quarantineNameFor(path: string, at: Date, label: string): string {
  return `${path}.${label}-${at.toISOString().replaceAll(':', '-').replace('.', '-')}`
}

/**
 * Move a file whose contents could not be read as JSON out of the way.
 *
 * **This is the whole of the "a corrupt store is not overwritten" rule.** Every
 * JSON store in this package treated a parse failure as "keep the defaults",
 * and its next `save()` — which for most of them is the very next user action —
 * wrote the degraded in-memory state over the original bytes. One incident
 * therefore zeroed the settings, the connection profiles with their keys, and
 * the consent records, with nothing left to recover from. Renaming first costs
 * one syscall on a path that only runs when something is already wrong, and it
 * turns an unrecoverable incident into a file with an odd name.
 *
 * The rename, not a copy: a copy leaves the unparsable bytes at the path the
 * store will write to, so a reader who restarts before the first save sees the
 * same failure again, and a reader who does not gets their evidence silently
 * overwritten anyway.
 * @param path - the file that failed to parse.
 * @param at - the moment, injectable so a test can pin the name.
 * @param label - the word in the new name. `corrupt` for a file that would not
 *   parse, which is every caller but one: `key-protection`'s wrapped data key
 *   is set aside as `unreadable`, because bytes that are perfectly well formed
 *   and simply belong to another Windows account are not corrupt, and a name
 *   that said so would send the reader looking for the wrong thing.
 * @returns where it was moved to, or `undefined` when it could not be moved —
 *   which is itself worth reporting, because then the next save *will* land on
 *   top of it.
 */
export async function quarantineCorruptFile(
  path: string,
  at: Date = new Date(),
  label = 'corrupt',
): Promise<string | undefined> {
  const base = quarantineNameFor(path, at, label)
  // Two failures inside one millisecond are not a thing this expects, but a
  // rename onto an existing quarantine would destroy the earlier evidence,
  // which is the one outcome this whole function exists to prevent.
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const target = attempt === 0 ? base : `${base}-${String(attempt)}`
    // `rename` with a no-clobber flag is not portable, so the collision is
    // closed by a check and a counter rather than by the syscall; the loser of
    // a true race overwrites a quarantine holding bytes that failed to parse
    // for the same reason, which is a loss of nothing.
    if (existsSync(target)) continue
    try {
      await rename(path, target)
      return target
    } catch {
      return undefined
    }
  }
  return undefined
}

/**
 * Set aside a file that would not parse, and say so in one sentence.
 *
 * Separate from {@link readJsonStore} so the one store that reads its file in
 * two steps of its own — `settings.ts`, which has to tell "no file" from "not
 * looked yet" for a one-time migration — reports the same sentence rather than
 * writing a second one that would drift from it.
 * @param path - the file that failed to parse.
 * @param reason - what the parser said.
 * @param onProblem - told, once. Absent means silence.
 * @param at - the moment, injectable so a test can pin the quarantine name.
 * @returns where it was moved to, or `undefined` when it could not be moved.
 */
export async function quarantineUnparsable(
  path: string,
  reason: string,
  onProblem?: (message: string) => void,
  at?: Date,
): Promise<string | undefined> {
  const moved = await quarantineCorruptFile(path, at)
  onProblem?.(moved === undefined
    ? `${path} could not be read as JSON (${reason}) and could not be set aside;`
      + ' the defaults are in use and the next save will overwrite it'
    : `${path} could not be read as JSON (${reason}); it was kept as ${moved}`
      + ' and the defaults are in use')
  return moved
}

/**
 * An empty table for keys that come from outside this process.
 *
 * Several of this package's stores are partitioned by a string nobody here
 * chose — a character id, which is a *filename*, a preset's library name, a key
 * a card handed `localStorage`. On a plain object three of those strings are
 * not keys at all: `table['__proto__'] = row` re-points the table's prototype
 * instead of storing a row, and `table['constructor']` answers a function that
 * was never written. `Object.create(null)` removes the whole class of question
 * for the price of one call, and `JSON.stringify` cannot tell the difference —
 * the file on disk is byte-identical, which is what keeps the persistence
 * tests green.
 *
 * A file read back with `readJsonStore` is an *ordinary* object, so a store
 * restoring one must copy it through here rather than adopt it: `JSON.parse`
 * does create `__proto__` as a real own key, and adopting that object is how
 * the poisoned prototype would arrive from disk.
 * @param from - an existing table to copy in, e.g. one just parsed from the file.
 * @returns a table with no prototype.
 */
export function wireKeyedTable<T>(from?: Record<string, T>): Record<string, T> {
  const table = Object.create(null) as Record<string, T>
  return from === undefined ? table : Object.assign(table, from)
}

/**
 * Read a store's JSON file, setting it aside when it will not parse.
 *
 * The three outcomes a store has to tell apart, and used to collapse into one
 * `catch`: **nothing saved yet** (the state every install starts in, and not a
 * problem), **unreadable** (a permission or an I/O failure — the bytes may be
 * perfectly good, so nothing is moved), and **corrupt** (the bytes are there
 * and are not JSON, which is the only case that quarantines). Every store in
 * this package went through the first branch for all three, which is why a
 * corrupt file was indistinguishable from a fresh profile.
 *
 * Shape validation stays with the store: a file that parses but carries the
 * wrong shape is a different question — it may be a file from an older build,
 * and each store already decides what of it to keep.
 * @param path - the store's file.
 * @param onProblem - told, once, when a file was set aside, could not be set
 *   aside, or was there and could not be read. Never told about a file that is
 *   simply absent. Absent means silence, which is what a store constructed by a
 *   test wants.
 * @param at - the moment, injectable so a test can pin the quarantine name.
 * @returns the parsed value, or `undefined` when there is nothing to restore.
 */
export async function readJsonStore(
  path: string,
  onProblem?: (message: string) => void,
  at?: Date,
): Promise<unknown> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error: unknown) {
    // `ENOENT` is a first run and says nothing; anything else — a permission,
    // a lock, an I/O failure — is a file that exists and whose contents are
    // about to be replaced by the defaults, which is the fact `script-variables`
    // already singled out for exactly this reason and every other store here
    // swallowed. Nothing is moved: the bytes may be perfectly good.
    if ((error as { code?: string }).code !== 'ENOENT') {
      onProblem?.(`${path} could not be read`
        + ` (${error instanceof Error ? error.message : String(error)});`
        + ' the defaults are in use and saving will overwrite the file')
    }
    return undefined
  }
  try {
    return JSON.parse(text)
  } catch (error: unknown) {
    await quarantineUnparsable(
      path, error instanceof Error ? error.message : String(error), onProblem, at)
    return undefined
  }
}
