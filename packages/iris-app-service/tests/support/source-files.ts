import { readdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

/**
 * Every `.ts` file under this package's `src/`, read as text.
 *
 * For the source-text fences whose subject is "this package's own source" and
 * not one file. Such a fence used to read `src/service.ts` by name, which
 * holds today and goes silently **green** the day an arm moves into its own
 * module: the token the fence forbids can then appear in the new file and
 * nothing reads it. Walking the tree makes a split neutral to the fence.
 *
 * A walk can break too, for example a wrong root, a filter that drops every
 * file, or a `recursive` option that stops recursing. A broken walk returns
 * nothing and every fence built on it passes. So each caller asserts
 * {@link SOURCE_FILE_FLOOR} against the count it actually scanned.
 *
 * @returns files sorted by path, with the path relative to `src/` in POSIX
 *   form.
 */
export async function packageSourceFiles(): Promise<Array<{ file: string, text: string }>> {
  const root = fileURLToPath(new URL('../../src/', import.meta.url))
  const names = (await readdir(root, { recursive: true }))
    .map(name => name.split('\\').join('/'))
    .filter(name => name.endsWith('.ts'))
    .sort()
  return Promise.all(names.map(async file => ({
    file,
    text: await readFile(new URL(`../../src/${file}`, import.meta.url), 'utf8'),
  })))
}

/**
 * The fewest source files a working walk can return.
 *
 * Measured on 2026-09-25 (origin/main dc5662d): 68 `.ts` files under
 * `packages/iris-app-service/src`. The floor sits below that so that deleting
 * a module is not a test failure, and far above 1, which is the count a walk
 * that has silently fallen back to `service.ts` alone would give. Raise it
 * when the tree grows well past it; lowering it needs a reason.
 */
export const SOURCE_FILE_FLOOR = 60
