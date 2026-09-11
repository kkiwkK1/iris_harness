/**
 * One host per data directory.
 *
 * Every store in this package is a whole-file rewrite from in-memory state:
 * `SettingsStore`, `ConnectionStore`, `ChatStore`, `ScriptVariableStore` and
 * the nine others each hold their file's content in the process and replace the
 * file when something changes. §68 made each of those writes *atomic*, so a
 * crash can no longer leave a half-file — but atomicity is about one writer.
 * Two hosts opened on one directory are two in-memory copies of the same files,
 * and the second one's save overwrites the first one's newer file whole, with
 * no error on either side. What is lost is whatever the other host learned
 * since it read: floors, usage rows, script variables, a saved connection.
 *
 * It has happened on this machine. Two hosts (8787 and 8790) were run against
 * the one checkout's `apps/iris/data`, and the consequences were diagnosed as
 * product defects for three rounds before the sharing was noticed — one host
 * serving a stale build against the other's files reads exactly like a bug in
 * the feature you are looking at (`notes/DEVIATIONS.md`, task Z1). A second
 * incident put eleven chats into a dev checkout's profile when a QA host died
 * on `EADDRINUSE` and its RPCs went to the host that owned the port instead.
 *
 * **So a data directory has one host, enforced at startup.** The lock is a file
 * — `<dataDir>/host.lock` — created with `open(path, 'wx')`, which is the one
 * filesystem primitive that makes "create it if and only if nobody else did" a
 * single operation (`O_EXCL`; the check-then-create spelling has a window
 * between the two calls and is not a lock at all). It records who holds it, so
 * the refusal can say something more useful than "locked".
 *
 * **A lock file is not released by a crash**, and that is deliberate: a
 * `process.exit` from a fatal error, a `SIGKILL`, a power cut and a blue screen
 * all leave the file behind, and there is no shutdown hook that covers them.
 * That is what the liveness probe is for — a lock whose recorded pid is not
 * running is *stale*, and the next host takes it over and says so. The cost of
 * the probe being wrong in the safe direction (reading a dead pid as alive) is
 * one manual deletion; the cost of the unsafe direction is the incident this
 * module exists to close, which is why `EPERM` — "that process exists and is
 * not yours to signal" — counts as alive.
 *
 * **There is no escape-hatch flag.** A `--allow-shared-data-dir` would be
 * reached for in exactly the situation that produced both incidents: someone in
 * a hurry who believes this time it is fine. Running a second host is still a
 * supported thing to do — it takes a second data directory (`IRIS_DATA_DIR`),
 * which is a copy away, and that is what the README's 多实例 section says.
 *
 * Upstream has no equivalent. SillyTavern excludes a second instance by
 * *port*: `src/server-startup.js:238-240` turns `EADDRINUSE` into "Another
 * SillyTavern instance may already be running. Stop the other process or change
 * "port" in config.yaml." and exits. Nothing in `server.js` or `src/` opens a
 * file with `wx`, `O_EXCL` or any lock library — the one `'wx'` in the tree is
 * `src/endpoints/assets.js:237`, a download refusing to overwrite its
 * destination. Two SillyTavern processes on two ports sharing one `--dataRoot`
 * have the same hazard this file refuses, undetected.
 *
 * @module @iris/app-service/host-lock
 */

import { mkdir, open, readFile, unlink } from 'node:fs/promises'
import { hostname } from 'node:os'
import { join } from 'node:path'

/** The lock's file name inside the data directory. */
export const HOST_LOCK_FILE = 'host.lock'

/** What a lock file says about the host that holds it. */
export interface HostLockRecord {
  /** The holder's process id, as the liveness probe reads it. */
  pid: number
  /** The port it **bound**, absent when the carrier had not bound one. */
  port?: number
  /** ISO-8601 UTC, so the refusal can say how long it has been held. */
  startedAt: string
  /** The machine, for the case where the directory is on a share. */
  hostname: string
}

/** A held lock, and the one thing its owner may do with it. */
export interface HostLock {
  /** The lock file's absolute path. */
  path: string
  /** What this host wrote into it. */
  record: HostLockRecord
  /**
   * One line for the log when this host took a **stale** lock over, absent
   * when it created the lock fresh. Taking over is normal after a crash and
   * silence about it is not: the line is how a reader learns that the previous
   * host did not shut down, which is the signal that something killed it.
   */
  takeover?: string
  /** Give the lock up. Safe to call twice, and a no-op once someone else holds it. */
  release: () => Promise<void>
}

/** Options, all injectable so the tests never depend on this process's identity. */
export interface HostLockOptions {
  /** The port this host **bound** — the actual one, not the configured one. */
  port?: number
  /** This process's id. Defaults to `process.pid`. */
  pid?: number
  /** The machine name. Defaults to `os.hostname()`. */
  hostname?: string
  /** The clock. Defaults to `Date`. */
  now?: () => Date
  /** The liveness probe. Defaults to {@link isPidAlive}. */
  isAlive?: (pid: number) => boolean
}

/**
 * Is a process with this id running?
 *
 * `kill(pid, 0)` sends no signal; it performs the permission and existence
 * check and nothing else, which is the portable spelling of this question on
 * both POSIX and Windows (Node's Windows implementation opens the process
 * handle and reports `ESRCH` when there is none).
 *
 * The three outcomes are not two:
 *
 * - it returns — the process exists and we may signal it. **Alive.**
 * - `ESRCH` — no such process. **Dead**, and the lock is stale.
 * - `EPERM` — a process with that id exists and belongs to another user.
 *   **Alive.** This is the case a naive `catch { return false }` gets exactly
 *   backwards, and getting it backwards means taking over a lock a running
 *   host still holds, which is the incident. A shared data directory on a
 *   multi-user machine, or a host started by a service account, is how it
 *   arrives.
 *
 * Non-integers and ids at or below zero are refused rather than probed: `0` is
 * the calling process's *group* on POSIX, and a garbled lock file naming pid 0
 * must not be read as "the group is alive".
 * @param pid - the process id from a lock file.
 * @param kill - the probe, injectable for the `EPERM` case which cannot be produced on demand.
 * @returns whether a process with that id is running.
 */
export function isPidAlive(
  pid: number,
  kill: (pid: number, signal: 0) => void = (id, signal) => { process.kill(id, signal) },
): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    kill(pid, 0)
    return true
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException | undefined)?.code === 'EPERM'
  }
}

/**
 * Read a lock file's bytes back as a record.
 *
 * A file that does not parse, or parses to something without a usable pid, is
 * **not** an error here — it returns undefined, and the caller treats that as
 * stale. The reasoning: the only thing a lock file is for is naming a process
 * to probe, and bytes that name no process cannot hold anything. A half-written
 * file from a crash mid-write is the likeliest way to get here, and refusing to
 * start over an unreadable byte string would turn a crash into a directory
 * nobody can open. It is reported rather than passed over silently, because
 * "your lock file was garbage" is a fact about the previous shutdown.
 * @param text - the file's content.
 * @returns the record, or undefined when the bytes name no process.
 */
export function readLockRecord(text: string): HostLockRecord | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const raw = parsed as Record<string, unknown>
  const pid = raw['pid']
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return undefined
  const port = raw['port']
  return {
    pid,
    ...typeof port === 'number' && Number.isInteger(port) ? { port } : {},
    startedAt: typeof raw['startedAt'] === 'string' ? raw['startedAt'] : 'an unrecorded time',
    hostname: typeof raw['hostname'] === 'string' ? raw['hostname'] : 'an unrecorded machine',
  }
}

/**
 * The sentence a refused host prints, and the only thing the person gets.
 *
 * It names all four things they need: **where** the lock is (so they can look
 * at it, and delete it if they know better than the probe), **which** process
 * holds it, **what port** that process says it bound (which is how they find
 * the window it is serving), and **the two ways forward**. No flag is offered,
 * because there is none.
 * @param path - the lock file.
 * @param record - what it says.
 * @returns one sentence, no trailing newline.
 */
export function describeHeldLock(path: string, record: HostLockRecord): string {
  const port = record.port === undefined ? 'an unrecorded port' : `port ${String(record.port)}`
  return `iris: this data directory is already open by another host — ${path} records pid `
    + `${String(record.pid)} on ${port} (started ${record.startedAt} on ${record.hostname}). `
    + 'Two hosts sharing one data directory overwrite each other\'s files whole, so this one '
    + 'will not start. Stop that host, or point IRIS_DATA_DIR at another directory.'
}

/** The line logged when a stale lock is taken over. */
function describeTakeover(path: string, record: HostLockRecord | undefined): string {
  if (record === undefined) {
    return `iris: ${path} was there but did not parse as a lock, so it names no process to check. `
      + 'Treating it as stale and taking the data directory over — the previous host did not shut down cleanly.'
  }
  return `iris: ${path} was left behind by pid ${String(record.pid)} (started ${record.startedAt}), `
    + 'which is no longer running. Taking the data directory over — that host did not shut down cleanly.'
}

/** Write the record with `wx`, answering whether the create was refused as taken. */
async function createExclusive(path: string, record: HostLockRecord): Promise<'created' | 'taken'> {
  let handle
  try {
    handle = await open(path, 'wx')
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === 'EEXIST') return 'taken'
    throw error
  }
  try {
    await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, 'utf8')
  } finally {
    await handle.close()
  }
  return 'created'
}

/**
 * Take the data directory, or refuse to start.
 *
 * @param dataDir - the directory holding every profile; the lock sits at its root
 *   rather than inside a profile, because the hazard is two hosts on one *tree*
 *   and two hosts on one tree with different `IRIS_PROFILE` values still share
 *   the backups, the worlds and each other's file handles.
 * @param options - the bound port and the injectable identity, clock and probe.
 * @returns the held lock, carrying the takeover line when one was needed.
 * @throws {Error} with {@link describeHeldLock}'s sentence when a live host holds it.
 */
export async function acquireHostLock(dataDir: string, options?: HostLockOptions): Promise<HostLock> {
  const path = join(dataDir, HOST_LOCK_FILE)
  const isAlive = options?.isAlive ?? (pid => isPidAlive(pid))
  const record: HostLockRecord = {
    pid: options?.pid ?? process.pid,
    ...options?.port === undefined ? {} : { port: options.port },
    startedAt: (options?.now?.() ?? new Date()).toISOString(),
    hostname: options?.hostname ?? hostname(),
  }

  await mkdir(dataDir, { recursive: true })

  if (await createExclusive(path, record) === 'created') {
    return { path, record, release: () => releaseHostLock(path, record) }
  }

  // Taken. Whose, and is it alive?
  const text = await readFile(path, 'utf8').catch(() => undefined)
  if (text === undefined) {
    // Gone between the failed create and the read: the holder released it in
    // that window. One more attempt, and a second EEXIST is reported as held
    // rather than looped on, because a directory two hosts are fighting over is
    // the thing this refuses, not a race to win.
    if (await createExclusive(path, record) === 'created') {
      return { path, record, release: () => releaseHostLock(path, record) }
    }
    const again = readLockRecord(await readFile(path, 'utf8').catch(() => ''))
    throw new Error(describeHeldLock(path, again ?? { pid: 0, startedAt: 'an unrecorded time', hostname: 'an unrecorded machine' }))
  }

  const held = readLockRecord(text)
  if (held !== undefined && isAlive(held.pid)) throw new Error(describeHeldLock(path, held))

  // Stale — a crash, a kill, or a half-written file. Take it over.
  const takeover = describeTakeover(path, held)
  await unlink(path).catch(() => undefined)
  if (await createExclusive(path, record) === 'taken') {
    // Another host took the same stale lock over first. It is alive by
    // construction, so this is the held case and not another round of takeover.
    const winner = readLockRecord(await readFile(path, 'utf8').catch(() => ''))
    throw new Error(describeHeldLock(path, winner ?? { pid: 0, startedAt: 'an unrecorded time', hostname: 'an unrecorded machine' }))
  }
  return { path, record, takeover, release: () => releaseHostLock(path, record) }
}

/**
 * Give a lock up, but only if it is still ours.
 *
 * The identity check is `pid` **and** `startedAt`, not `pid` alone: process ids
 * are recycled, and a release that deleted any lock naming our pid would let a
 * shutting-down host delete the lock of the host that started after it and
 * happened to be given the same id.
 * @param path - the lock file.
 * @param record - what we wrote into it.
 */
async function releaseHostLock(path: string, record: HostLockRecord): Promise<void> {
  const text = await readFile(path, 'utf8').catch(() => undefined)
  if (text === undefined) return
  const held = readLockRecord(text)
  if (held?.pid !== record.pid || held.startedAt !== record.startedAt) return
  await unlink(path).catch(() => undefined)
}
