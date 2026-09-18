import { mkdtemp, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TestContext } from 'node:test'

/**
 * The one temporary-directory rule for the unit tests.
 *
 * `qa/chrome-profile.mjs` states the same rule for the scripts that start a
 * browser, after 321 abandoned Chrome profiles totalling 11.5 GB were found in
 * `%TEMP%` on 2026-09-19. The tests are the other population found the same
 * day, and they leak by count rather than by size: about **45 000 directories**
 * of 0.2–1.1 KB each, `iris-wb-write-` 10 457, `iris-src-` 8 553,
 * `iris-persona-` 6 499, `iris-sandbox-cors-` 3 348 and a long tail. Thirty
 * megabytes is nothing; a temp folder with tens of thousands of entries slows
 * every tool that lists it, and two `npm test` runs added 519 more.
 *
 * The leak was never a wrong line. Ninety-five of the 122 files already wrote
 *
 * ```ts
 * const dir = await mkdtemp(join(tmpdir(), 'iris-x-'))
 * t.after(async () => { await rm(dir, { recursive: true, force: true }) })
 * ```
 *
 * and the 24 leaking call sites are the ones where the second line is simply
 * not there. A missing line is invisible in review, so the fix is to make the
 * first line carry the second: `tempDir` registers the removal at the moment
 * it hands the directory over, and `apps/iris/tests/temp-dir-discipline.test.ts`
 * pins that no test reaches `mkdtemp` any other way.
 *
 * ## Why this mirrors `qa/chrome-profile.mjs` instead of importing it
 *
 * Three reasons, and the first two are hard:
 *
 *  1. `qa/` is not in the root TypeScript program — `tsconfig.json` includes
 *     `packages/​*​/src`, `packages/​*​/tests`, `apps/iris/​**` and `scripts/​**`,
 *     and the module is JSDoc-typed JavaScript. A `.ts` test importing it would
 *     pull an un-included `.mjs` into the program under `allowJs`;
 *  2. its `tempDir` returns a handle that installs `process.on('exit')` /
 *     `SIGINT` / `SIGTERM` handlers and **adopts a child process** to kill
 *     before removing. That is the right contract for a flat top-level script
 *     that ends in `process.exit()`. A `node:test` file does not need it:
 *     `t.after` is guaranteed to run whether the test passes, fails or throws;
 *  3. direction — a package's tests should not depend on repo-root QA tooling.
 *
 * What *is* shared is the part that was learned the hard way: the removal
 * semantics. {@link REMOVE_RETRIES} is the same 30 × 200 ms budget, chosen
 * there because 1.4 s lost a real race against a dying process on Windows, and
 * the rename-aside fallback below is the same one, for the same `EPERM` on a
 * directory that is open rather than merely locked.
 *
 * Known environment quirk: `fs.rm(dir, { recursive: true })` silently removes
 * nothing when `dir` is inside this repository (memory note
 * `node-recursive-rm-noops-in-project-dir`). Everything here is made under
 * `os.tmpdir()`, where it works — which is why {@link tempDir} composes the
 * path itself rather than taking one.
 *
 * ## Why this file lives here
 *
 * `packages/iris-app-service/tests/support/` is the tree's only shared
 * test-support directory and is already imported across trees —
 * `apps/iris/tests/live-generation-kinds.test.ts` reaches `materialising-store.ts`
 * by relative path, and `fetchable-port.ts` records the same reasoning. This
 * module imports nothing of ours, so it adds no package dependency in either
 * direction. If a neutral shared location is ever created, it moves there
 * unchanged.
 *
 * @module @iris/app-service/tests/support/temp-dir
 */

/**
 * `rm` retry budget — about 6 s.
 *
 * Node retries `EPERM`/`EBUSY`/`ENOTEMPTY` here, which is the shape a process
 * that has not quite let go of a file produces on Windows. The number is copied
 * from `qa/chrome-profile.mjs` deliberately: a smaller budget there (1.4 s)
 * lost a real race on 2026-09-19, and two budgets that drift apart would mean
 * two different answers to the same question.
 *
 * The tests had already found the same race from their own side, and this is
 * where that knowledge now lives, because the `maxRetries` it used to justify
 * is no longer written at 95 call sites. What eight files recorded, in the
 * comments this module replaced: on Windows a handle inside `chats/` survives
 * `settle()` by a moment, and a bare recursive `rm` then fails the **whole
 * file** with `EBUSY` or `ENOTEMPTY` — *after* every assertion has passed,
 * which is what made it read as a racy assertion under parallel load rather
 * than as a tidy-up. Measured on `scoped-regex.test.ts`: 7 of 24 parallel runs
 * failed this way before the retry, 0 after. The window widened with the
 * atomic-write change of 2026-09-11, which replaced one write syscall per save
 * with a write and a rename. Only the tidy-up waits; the tests do not.
 */
const REMOVE_RETRIES = { maxRetries: 30, retryDelay: 200 }

/**
 * Remove a temporary directory, with the fallback Windows needs.
 *
 * Never throws. A cleanup that fails must not turn a green test red — the test
 * has already made its claim by the time this runs, and a red line here would
 * say "the assertion failed" about a directory handle. What it does instead is
 * say so on stderr, by path, so a run that starts leaking again is visible.
 *
 * The fallback is a rename to `<dir>.gone-<pid>`: a directory that cannot be
 * deleted because something still holds it open can almost always still be
 * moved, and a renamed name is a name a sweep can find later. The directories
 * here hold synthetic fixtures — a `connections.json` written by a test holds
 * the string `test-key`, not a credential — so the "remove, never rename"
 * ruling that `qa/chrome-profile.mjs` applies to a copy of the product's real
 * data dir does not reach this population.
 *
 * @param dir - a directory previously returned by {@link tempDir} or
 *   {@link tempDirOwned}.
 */
export async function removeTempDir(dir: string): Promise<void> {
  if (dir === '') return
  try {
    await rm(dir, { recursive: true, force: true, ...REMOVE_RETRIES })
    return
  } catch (error) {
    try {
      await rename(dir, `${dir}.gone-${String(process.pid)}`)
      return
    } catch { /* fall through to the report */ }
    console.error(`[temp] could not remove ${dir}: ${String(error)}`)
  }
}

/**
 * A temporary directory that removes itself when this test ends.
 *
 * The common case, and the one the discipline test pins. `t.after` runs
 * whether the test passes, fails or throws, and it runs before the next test
 * starts, so the directory's lifetime is exactly the test's.
 *
 * A module-level factory that makes a directory for a test — `storeWith`,
 * `bookWith`, `tempRoot` and friends — takes the `TestContext` as its first
 * parameter and passes it here, rather than reaching for a second mechanism.
 * That is why the parameter comes first: it is the thing being threaded.
 *
 * @param t - the running test's context.
 * @param prefix - an `mkdtemp` prefix ending in `-`, e.g. `'iris-persona-'`.
 *   Keep a file's historical prefix when converting it; the prefixes are how a
 *   leak on disk is traced back to the test that made it.
 * @returns the directory. It exists when the promise resolves.
 */
export async function tempDir(t: TestContext, prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  t.after(async () => { await removeTempDir(dir) })
  return dir
}

/**
 * A temporary directory whose removal the caller schedules itself.
 *
 * For the two shapes `t.after` cannot serve:
 *
 *  - a directory made in a file-level `before()` hook, where there is no
 *    `TestContext` at all;
 *  - a directory a spawned host is still running out of, which must not be
 *    removed until that host has been stopped and waited for. Removing it from
 *    a `t.after` that runs before the host's own shutdown would delete the data
 *    directory out from under a live process.
 *
 * Both end in the file's own `after()` hook calling {@link removeTempDir} at
 * the right moment. The name is the point: `tempDirOwned` reads as a debt, and
 * the discipline test counts its call sites so the shape cannot spread
 * silently back into the common case.
 *
 * @param prefix - an `mkdtemp` prefix ending in `-`.
 * @returns the directory. The caller must pass it to {@link removeTempDir}.
 */
export async function tempDirOwned(prefix: string): Promise<string> {
  return await mkdtemp(join(tmpdir(), prefix))
}
