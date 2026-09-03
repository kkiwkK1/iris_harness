import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

/**
 * No source file carries a raw control character.
 *
 * **Written as a gate because the alternative is remembering.** Three files had
 * carried one for months: a NUL in `key-order.test.ts`, a NUL in
 * `unit.test.ts`, and — the one that was not merely untidy — a `\1`
 * backreference in `LONG-CHAT-VARIABLES.md` that had collapsed into a `0x01`,
 * so the document printed a **different regex** from the one it was documenting.
 *
 * All three type-checked, kept every test green, and rendered without a mark.
 * **Typecheck, tests and rendering are all blind to this class of damage; only
 * the bytes show it.** What eventually found them was `grep` — not by matching,
 * but by reporting what it could not see (`binary file matches`).
 *
 * A rule saying "scan for these periodically" would lean on the same memory that
 * the rule against writing them leans on, and that memory has already failed
 * once *while its own rule was being written*. So it runs here instead.
 *
 * The allowlist is empty on purpose. Nothing in this repository has a
 * legitimate reason to hold a raw control byte — a value that needs one writes
 * it as an escape, which is the whole point. If a real exception ever turns up,
 * add it here **with its reason**, so the next reader inherits the argument
 * rather than a bare exemption.
 */

/** Extensions worth reading. Anything genuinely binary is not in this list. */
const EXTENSIONS = ['.ts', '.tsx', '.mjs', '.md', '.css', '.json', '.yml']

/** Directories that are not ours to police. */
const SKIP = new Set(['node_modules', '.git', 'dist', 'data', 'coverage'])

/**
 * Everything below `root` worth checking.
 * @param root - directory to walk.
 * @returns absolute file paths.
 */
function sourceFiles(root: string): string[] {
  const found: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIP.has(entry.name)) walk(join(dir, entry.name))
        continue
      }
      if (EXTENSIONS.some(extension => entry.name.endsWith(extension))) {
        found.push(join(dir, entry.name))
      }
    }
  }
  walk(root)
  return found
}

/**
 * Where a raw control character sits, if one does.
 *
 * Tab, newline and carriage return are excluded, being the three that belong in
 * text. `\x7f` is left out too: it is not a shape escape-collapse produces, and
 * a range is easier to trust when every member of it has a known cause.
 */
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f]/u

test('no source file carries a raw control character', () => {
  const root = join(import.meta.dirname, '..', '..', '..')
  const offenders: string[] = []

  let scanned = 0
  for (const directory of ['packages', 'apps']) {
    for (const file of sourceFiles(join(root, directory))) {
      scanned += 1
      const text = readFileSync(file, 'utf8')
      const at = text.search(CONTROL)
      if (at < 0) continue
      const line = text.slice(0, at).split('\n').length
      const code = text.charCodeAt(at).toString(16).padStart(2, '0')
      offenders.push(`${file.slice(root.length + 1)}:${String(line)}: byte ${String(at)} is 0x${code}`)
    }
  }

  // A floor on the sample, because a walk that silently found nothing to read
  // would pass exactly as loudly as a clean tree.
  assert.ok(scanned > 200, `only ${String(scanned)} files were scanned; the walk is not reaching the source`)
  assert.deepEqual(offenders, [], `raw control characters found:\n  ${offenders.join('\n  ')}`)
})
