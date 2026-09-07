import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, posix } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

/**
 * Every reference to a file in this repository must point at a file that
 * exists.
 *
 * Three populations, kept apart because they break for different reasons and a
 * single count would hide which:
 *
 *  1. **markdown links** in `.md` — `[text](path)`, resolved relative to the
 *     linking file;
 *  2. **`path:line` citations** in `.md` — `packages/x/src/y.ts:123`, written
 *     from the repository root the way this project's notes cite evidence;
 *  3. **`.md` names in source comments** — a bare `SANDBOX.md` or a slashed
 *     `docs/SANDBOX.md` in a `.ts` / `.mjs` / `.yml` comment. A bare name
 *     resolves against the set of tracked `.md` basenames; a slashed one
 *     against the root, then against the commenting file.
 *
 * Why this exists: on 2026-09-06 fifty-five documents moved into `docs/` and
 * `notes/`, and nothing in the build could have noticed. A comment pointing at
 * a path that no longer exists compiles, renders and reviews exactly like one
 * that does. Worse, one test *read* the moved document at runtime inside a
 * `try { } catch { return }` — it would have kept passing while asserting
 * nothing (`packages/iris-script/tests/remote.test.ts`, since fixed). The
 * check here is the one that goes red the next time a document moves.
 *
 * Existence is checked against `git ls-files`, not the filesystem, so a
 * casing mistake fails here on Windows the way it would on a Linux runner.
 *
 * Lives at the composition root because, like `architecture.test.ts`, it is
 * about the whole tree.
 */

// `fileURLToPath`, not `.pathname`: this repository's own path contains
// non-ASCII characters, which a URL percent-encodes.
const ROOT = fileURLToPath(new URL('../../../', import.meta.url))

// Tracked files plus untracked-but-not-ignored ones: a document written this
// turn and not yet `git add`ed is a legitimate link target, and a build
// artifact under an ignored directory is not.
const tracked = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: ROOT, encoding: 'utf8' })
  .split('\n').map(line => line.trim()).filter(line => line !== '')
const trackedSet = new Set(tracked)
const mdFiles = tracked.filter(path => path.endsWith('.md'))
const mdBasenames = new Set(mdFiles.map(path => posix.basename(path)))
/** Top-level directories of this tree; a citation into any other prefix is somebody else's file. */
const topLevelDirs = new Set(tracked.filter(path => path.includes('/')).map(path => path.split('/')[0] ?? ''))

/** A tracked file, or a directory some tracked file lives under. */
function exists(repoPath: string): boolean {
  if (trackedSet.has(repoPath)) return true
  const prefix = `${repoPath}/`
  for (const path of trackedSet) if (path.startsWith(prefix)) return true
  return false
}

function linesOf(file: string): string[] {
  return readFileSync(join(ROOT, file), 'utf8').split(/\r?\n/)
}

/** Resolve `target` written relative to `file`, as a repo-relative posix path. */
function relativeTo(file: string, target: string): string {
  return posix.normalize(posix.join(posix.dirname(file), target))
}

test('every markdown link in a tracked .md points at a file in the tree', () => {
  const broken: string[] = []
  let checked = 0
  for (const file of mdFiles) {
    let inFence = false
    linesOf(file).forEach((raw, index) => {
      // Code is not a link. A fenced block or an inline span may quote another
      // project's markdown verbatim (`- [Aladdin](LICENSE)` from TavernHelper's
      // README, for one) and renders as text, so it is not in the population.
      if (/^\s*(```|~~~)/.test(raw)) { inFence = !inFence; return }
      if (inFence) return
      const line = raw.replace(/`[^`]*`/g, '')
      for (const match of line.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
        const target = match[1] ?? ''
        if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue // http:, mailto:, …
        if (target.startsWith('#')) continue
        const path = target.split('#')[0] ?? ''
        if (path === '') continue
        checked += 1
        const resolved = relativeTo(file, decodeURIComponent(path))
        if (resolved.startsWith('..') || !exists(resolved)) broken.push(`${file}:${index + 1}: (${target}) -> ${resolved}`)
      }
    })
  }
  // A floor, not a pin: the README alone carries more than this. Below it the
  // scan has stopped seeing links, which is a failure of the check, not a
  // clean tree.
  assert.ok(checked >= 5, `only ${checked} markdown links found; the link scan is broken`)
  assert.deepEqual(broken, [], `${broken.length} markdown link(s) point at nothing:\n  ${broken.join('\n  ')}`)
})

test('every path:line citation in a tracked .md names a file in the tree', () => {
  const broken: string[] = []
  let checked = 0
  // `dir/…/name.ext:NN` where `dir` is one of this tree's top-level directories.
  // SillyTavern citations are written `public/scripts/x.js:NN` or `[ST] src/…`,
  // and `public/` is not a directory here, so they fall outside the population.
  const citation = /(?<![\w./-])((?:[\w.-]+\/)+[\w.-]+\.[A-Za-z]+):\d+/g
  for (const file of mdFiles) {
    linesOf(file).forEach((line, index) => {
      for (const match of line.matchAll(citation)) {
        const path = match[1] ?? ''
        if (!topLevelDirs.has(path.split('/')[0] ?? '')) continue
        checked += 1
        if (!trackedSet.has(path)) broken.push(`${file}:${index + 1}: ${path}`)
      }
    })
  }
  assert.ok(checked >= 10, `only ${checked} path:line citations found; the citation scan is broken`)
  assert.deepEqual(broken, [], `${broken.length} citation(s) name a file that is not in the tree:\n  ${broken.join('\n  ')}`)
})

test('every .md a source comment mentions exists', () => {
  const broken: string[] = []
  let checked = 0
  const sources = tracked.filter(path => /\.(ts|tsx|mts|js|mjs|cjs|yml|yaml)$/.test(path))
  const mention = /(?<![\w./-])((?:[\w.-]+\/)*[A-Za-z][\w.-]*\.md)\b/g
  for (const file of sources) {
    linesOf(file).forEach((line, index) => {
      for (const match of line.matchAll(mention)) {
        const target = match[1] ?? ''
        if (target.includes('/')) {
          const head = target.split('/')[0] ?? ''
          // `../../../docs/SANDBOX.md` — relative to the file.
          if (head === '..' || head === '.') {
            checked += 1
            if (!trackedSet.has(relativeTo(file, target))) broken.push(`${file}:${index + 1}: ${target}`)
            continue
          }
          // `JS-Slash-Runner/CHANGELOG.md` — another project's file, not ours to resolve.
          if (!topLevelDirs.has(head)) continue
          checked += 1
          if (!trackedSet.has(posix.normalize(target))) broken.push(`${file}:${index + 1}: ${target}`)
          continue
        }
        checked += 1
        if (!mdBasenames.has(target)) broken.push(`${file}:${index + 1}: ${target}`)
      }
    })
  }
  assert.ok(checked >= 50, `only ${checked} .md mentions found in source; the mention scan is broken`)
  assert.deepEqual(broken, [], `${broken.length} .md mention(s) in source name a file that is not in the tree:\n  ${broken.join('\n  ')}`)
})
