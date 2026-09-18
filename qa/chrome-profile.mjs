/**
 * The one temporary-directory rule for every script that starts a browser.
 *
 * A headless Chrome needs a `--user-data-dir`, and an acceptance host needs a
 * copy of the product's data dir. Both are made in the system temp directory
 * and both were, until this module existed, simply abandoned: every script
 * built its own path inline, spawned Chrome at it, and exited. Measured on
 * 2026-09-19 the machine's `%TEMP%` held **321 abandoned Chrome profiles
 * totalling 11.5 GB** — an average profile is ~37 MB and a driven one reaches
 * 120 MB — spread over 90 distinct prefixes, most of them belonging to scripts
 * that no longer exist in the tree. Nothing ever removed one.
 *
 * So the rule is: **a script never names a temp path itself.** It asks here,
 * and what it gets back cleans itself up — on a normal return, on a thrown
 * error, on `process.exit()`, and on Ctrl-C.
 *
 * ## Why a handle and not only a `withChromeProfile` wrapper
 *
 * Almost every script in `qa/` is a flat top-level program: it spawns Chrome
 * at module scope, runs three hundred lines of top-level `await`, and ends in
 * `process.exit(failures ? 1 : 0)`. A `try/finally` cannot see that exit, and
 * an `async` cleanup registered on `'exit'` never runs, because the event loop
 * is already gone by then. What *does* run is a **synchronous** handler, so
 * the removal here is written twice: an `await`able {@link Handle.dispose} for
 * callers that have a body to wrap, and a synchronous fallback on `'exit'`,
 * `SIGINT`, `SIGTERM` and `uncaughtException` for the ones that do not.
 * {@link withChromeProfile} is the wrapper over the handle; both are exported
 * because the tree genuinely contains both shapes, and rewriting twenty flat
 * scripts into function bodies would have changed far more than the leak.
 *
 * ## Chrome must be dead first
 *
 * On Windows a running Chrome holds its profile open and the removal fails
 * with `EBUSY`/`EPERM`. So the child is killed and *waited for* before the
 * directory is touched — {@link Handle.adopt} is how a caller hands its child
 * over. `dispose` waits for the child's `exit` event with a bounded timeout
 * and escalates to `SIGKILL`; the synchronous path cannot wait on an event, so
 * it sends `SIGKILL` at once and lets `rmSync`'s own `maxRetries`/`retryDelay`
 * absorb the last moments of a dying renderer.
 *
 * ## When removal still fails
 *
 * A profile that refuses to go is **renamed aside** to `<dir>.gone-<pid>`, so
 * the next run's sweep — which matches on the prefix and therefore matches the
 * renamed name too — deletes it. A data copy is not: it holds `connections.json`
 * and therefore key material, so ruling 3 of this task is that it must be
 * *removed*, never left under another name. It gets a second, harder attempt,
 * then the key-bearing files are deleted individually, and the failure is
 * reported by path. The path is named; its contents never are.
 *
 * ## The sweep
 *
 * Creating a directory also sweeps its own siblings: same prefix, same temp
 * root, last modified over an hour ago. That hour is what makes the sweep safe
 * to run while another copy of the same script is running — a live profile is
 * written to constantly — and it is what makes a past leak self-heal rather
 * than needing this module to have existed when it was made.
 *
 * Known environment quirk: `fs.rmSync(dir, { recursive: true })` silently
 * deletes nothing when `dir` is inside this repository (see the memory note
 * `node-recursive-rm-noops-in-project-dir`). Everything here lives under
 * `os.tmpdir()`, where it works; the sweep's return count is what proves it,
 * and `IRIS_TEMP_VERBOSE=1` prints it.
 *
 * @module qa/chrome-profile
 */

import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Anything older than this, under the same prefix, is somebody's abandoned run. */
const STALE_AFTER_MS = 60 * 60 * 1000

/**
 * `rmSync`/`rm` retry budget — about 6s.
 *
 * Node retries `EPERM`/`EBUSY` here, which is exactly the shape a dying Chrome
 * produces. The first version of this file allowed 1.4s and a real run
 * (`qa/r-cards-check.mjs` failing mid-page on 2026-09-19) still lost the race:
 * `EPERM` on the profile, and then `EPERM` on the rename-aside too, because
 * the directory was open rather than merely locked. The budget is one half of
 * that fix; {@link killTreeSync} is the other, and the more important one.
 */
const REMOVE_RETRIES = { maxRetries: 30, retryDelay: 200 }

/** How long `dispose` waits for a killed child to actually exit, per escalation. */
const KILL_WAIT_MS = 5000
const SIGKILL_WAIT_MS = 2000

/** Live handles, in creation order. Emptied by whichever cleanup path runs first. */
const live = []

let handlersInstalled = false

const verbose = process.env.IRIS_TEMP_VERBOSE === '1'

/** @param {string} line */
function note(line) {
  if (verbose) console.error(`[temp] ${line}`)
}

/**
 * Remove the stale siblings of `prefix` in the temp root.
 *
 * Errors are swallowed per entry on purpose: a directory that belongs to a
 * *running* sibling process fails to open, and that is the correct outcome —
 * the age check should already have excluded it, and if it did not, refusing
 * is better than deleting a live profile.
 *
 * @param {string} prefix - the `mkdtemp` prefix, e.g. `'iris-qa-cdp-'`.
 * @returns {number} how many directories were actually removed.
 */
export function sweepStale(prefix) {
  const root = tmpdir()
  let names
  try {
    names = readdirSync(root)
  } catch {
    return 0
  }
  const now = Date.now()
  let swept = 0
  for (const name of names) {
    if (!name.startsWith(prefix)) continue
    const full = join(root, name)
    try {
      const stat = statSync(full)
      if (!stat.isDirectory()) continue
      if (now - stat.mtimeMs < STALE_AFTER_MS) continue
      rmSync(full, { recursive: true, force: true, maxRetries: 2, retryDelay: 50 })
      swept += 1
    } catch { /* in use, or another user's; leave it for the run that owns it */ }
  }
  if (swept > 0) note(`swept ${String(swept)} stale ${prefix}* director${swept === 1 ? 'y' : 'ies'}`)
  return swept
}

/**
 * Install the process-wide cleanup once.
 *
 * `'exit'` covers the flat scripts' `process.exit()` and a normal fall off the
 * end. The signal handlers exist because a signal's *default* action skips
 * `'exit'` entirely; each one cleans up and then exits with the conventional
 * `128 + signal`. `uncaughtException` and `unhandledRejection` reproduce
 * node's own behaviour — print to stderr, exit 1 — with the removal in front
 * of it, which is the only reason they are installed at all.
 */
function installHandlers() {
  if (handlersInstalled) return
  handlersInstalled = true
  process.on('exit', () => { disposeAllSync() })
  /** @type {[NodeJS.Signals, number][]} */
  const signals = [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129], ['SIGBREAK', 149]]
  for (const [signal, code] of signals) {
    try {
      process.once(signal, () => { void leave(code) })
    } catch { /* SIGBREAK is Windows-only, SIGHUP is not; neither is required */ }
  }
  process.once('uncaughtException', error => {
    console.error(error)
    void leave(1)
  })
  process.once('unhandledRejection', reason => {
    console.error(reason)
    void leave(1)
  })
}

/**
 * Clean up properly, then exit with `code`.
 *
 * A signal and an uncaught exception both arrive with the event loop still
 * running, so this is the one place the full kill-and-wait is affordable
 * outside a `finally`. The `'exit'` handler still runs afterwards and finds an
 * empty registry; if anything here throws, the synchronous path is what is
 * left, which is why the `catch` does not swallow the exit.
 *
 * @param {number} code
 */
async function leave(code) {
  try {
    await disposeAll()
  } catch (error) {
    console.error(`[temp] cleanup failed: ${String(error)}`)
  }
  process.exit(code)
}

/** @typedef {{dir: string, secret: boolean, child: import('node:child_process').ChildProcess | undefined, gone: boolean}} Entry */

/** @param {Entry} entry */
function forget(entry) {
  const at = live.indexOf(entry)
  if (at !== -1) live.splice(at, 1)
}

/**
 * Kill the adopted child **and everything it spawned**, synchronously.
 *
 * This is the part that was missing. `child.kill()` sends one signal to one
 * pid, and on Windows that is `TerminateProcess` on the Chrome *launcher* —
 * its renderer, GPU and network-service processes keep running, and they are
 * the ones holding files open inside the profile. The removal then fails with
 * `EPERM`, and so does the rename-aside, because the directory is open rather
 * than merely locked. `taskkill /T /F` takes the whole tree, and `spawnSync`
 * means it has finished before the removal is attempted — which is what makes
 * this usable from the synchronous `'exit'` handler, where waiting on the
 * child's `exit` event is not an option.
 *
 * @param {Entry} entry
 */
function killTreeSync(entry) {
  const child = entry.child
  if (child === undefined) return
  const pid = child.pid
  if (pid === undefined) return
  if (child.exitCode !== null || child.signalCode !== null) return
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
  }
  try { child.kill('SIGKILL') } catch { /* already gone */ }
}

/**
 * Remove `entry.dir`, synchronously, with the fallbacks ruling 1 and 3 ask for.
 * @param {Entry} entry
 */
function removeSync(entry) {
  if (entry.gone) return
  entry.gone = true
  try {
    rmSync(entry.dir, { recursive: true, force: true, ...REMOVE_RETRIES })
    return
  } catch (error) {
    if (!entry.secret) {
      // A profile is inert: rename it aside and let the next run's sweep have it.
      try {
        renameSync(entry.dir, `${entry.dir}.gone-${String(process.pid)}`)
        note(`renamed aside: ${entry.dir} (${String(error)})`)
        return
      } catch { /* fall through to the report below */ }
    } else {
      // A data copy holds key material. Try harder, then take the keys out by
      // hand, then say so. The path is named; its contents are not.
      try {
        rmSync(entry.dir, { recursive: true, force: true, maxRetries: 60, retryDelay: 250 })
        return
      } catch { /* fall through */ }
      for (const secret of ['connections.json', join('default-user', 'connections.json'), 'secrets.json']) {
        try { rmSync(join(entry.dir, secret), { force: true }) } catch { /* not present */ }
      }
    }
    console.error(`[temp] could not remove ${entry.dir}: ${String(error)}`)
  }
}

/** Kill and remove everything still live, synchronously. */
function disposeAllSync() {
  const pending = live.splice(0)
  // Every tree first, then every removal: two browsers dying in parallel beats
  // killing one, waiting out its file handles, and only then killing the next.
  for (const entry of pending) killTreeSync(entry)
  for (const entry of pending) removeSync(entry)
}

/**
 * Kill and remove everything still live, waiting properly for each child.
 *
 * Used by the handlers that still have an event loop — a signal and an
 * uncaught exception both arrive with the loop alive, so they can afford the
 * `exit`-event wait that the `'exit'` handler cannot.
 */
async function disposeAll() {
  const pending = live.splice(0)
  await Promise.all(pending.map(async entry => {
    await killAndWait(entry)
    removeSync(entry)
  }))
}

/**
 * Wait for an adopted child to actually exit, escalating to `SIGKILL`.
 * @param {Entry} entry
 */
async function killAndWait(entry) {
  const child = entry.child
  if (child === undefined) return
  if (child.exitCode !== null || child.signalCode !== null) return
  /** @param {number} ms */
  const exited = ms => new Promise(resolve => {
    const timer = setTimeout(() => { resolve(false) }, ms)
    timer.unref?.()
    child.once('exit', () => { clearTimeout(timer); resolve(true) })
  })
  try { child.kill() } catch { /* already gone */ }
  if (await exited(KILL_WAIT_MS)) return
  // Escalation takes the whole tree, for the reason in `killTreeSync`: the
  // launcher exiting is not the same event as its renderers letting go.
  killTreeSync(entry)
  await exited(SIGKILL_WAIT_MS)
}

/**
 * A temporary directory that removes itself.
 *
 * @typedef {object} Handle
 * @property {string} dir - the directory. It exists when the handle is returned.
 * @property {<T extends import('node:child_process').ChildProcess>(child: T) => T} adopt
 *   Hand over the browser (or host) running out of this directory, so cleanup
 *   kills it before removing. Returns the child, so it reads as a wrapper
 *   around the `spawn` call. Only the last adopted child is held.
 * @property {() => Promise<void>} dispose - kill the child, wait for it, remove
 *   the directory. Idempotent, and safe to call when a handler already ran.
 */

/**
 * Make a self-removing temporary directory.
 *
 * @param {string} prefix - a `mkdtemp` prefix ending in `-`, e.g. `'iris-r2-'`.
 *   It is also the sweep's key, so keep a script's historical prefix when
 *   converting it: that is what lets the sweep reach the leak already on disk.
 * @param {{secret?: boolean}} [options] - `secret: true` for a directory that
 *   holds key material, which must be removed rather than renamed aside.
 * @returns {Handle}
 */
export function tempDir(prefix, options = {}) {
  installHandlers()
  sweepStale(prefix)
  /** @type {Entry} */
  const entry = {
    dir: mkdtempSync(join(tmpdir(), prefix)),
    secret: options.secret === true,
    child: undefined,
    gone: false,
  }
  live.push(entry)
  note(`created ${entry.dir}`)
  return {
    dir: entry.dir,
    adopt(child) { entry.child = child; return child },
    async dispose() {
      forget(entry)
      await killAndWait(entry)
      removeSync(entry)
    },
  }
}

/**
 * A self-removing Chrome `--user-data-dir`.
 *
 * Identical to {@link tempDir}; it exists under its own name because that is
 * what the call sites are doing, and a reader of `chromeProfile('iris-r2-')`
 * does not have to ask what the directory is for.
 *
 * @param {string} prefix - a `mkdtemp` prefix ending in `-`.
 * @returns {Handle}
 */
export function chromeProfile(prefix) {
  return tempDir(prefix)
}

/**
 * A self-removing **copy** of the product's data dir.
 *
 * The copying is left to the caller: every caller has its own source
 * resolution and its own refusal message for a missing source, and those are
 * the parts worth keeping distinct. What is shared is the part that was
 * getting forgotten — the removal, which for a data copy is mandatory rather
 * than best-effort, because the copy carries `connections.json`.
 *
 * @param {string} prefix - a `mkdtemp` prefix ending in `-`.
 * @returns {Handle}
 */
export function dataCopy(prefix) {
  return tempDir(prefix, { secret: true })
}

/**
 * Run `body` with a Chrome profile, and remove it afterwards whatever happens.
 *
 * The wrapper form, for a caller whose work already sits inside a function.
 * A flat top-level script should use {@link chromeProfile} instead — see the
 * module comment for why the two shapes both exist.
 *
 * @template T
 * @param {string} prefix - a `mkdtemp` prefix ending in `-`.
 * @param {(handle: Handle) => Promise<T>} body
 * @returns {Promise<T>}
 */
export async function withChromeProfile(prefix, body) {
  const handle = chromeProfile(prefix)
  try {
    return await body(handle)
  } finally {
    await handle.dispose()
  }
}

/**
 * Run `body` with a plain temporary directory, and remove it afterwards.
 *
 * @template T
 * @param {string} prefix - a `mkdtemp` prefix ending in `-`.
 * @param {(handle: Handle) => Promise<T>} body
 * @returns {Promise<T>}
 */
export async function withTempDir(prefix, body) {
  const handle = tempDir(prefix)
  try {
    return await body(handle)
  } finally {
    await handle.dispose()
  }
}

/**
 * Run `body` with a data-dir copy, and remove it afterwards.
 *
 * @template T
 * @param {string} prefix - a `mkdtemp` prefix ending in `-`.
 * @param {(handle: Handle) => Promise<T>} body
 * @returns {Promise<T>}
 */
export async function withDataCopy(prefix, body) {
  const handle = dataCopy(prefix)
  try {
    return await body(handle)
  } finally {
    await handle.dispose()
  }
}
