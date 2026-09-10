/**
 * Coverage blind spots, refined: which src files are unreachable from any test
 * file through the import graph (tests' own transitive imports included).
 *
 * Resolves relative specifiers the way the bundler does: `./x` and `../x` to
 * `x.ts` / `x.tsx` / `x.mjs` / `x.js` / `x/index.ts`; bare specifiers stop the
 * walk (another package or a dependency — that package's own tests own them).
 * Alias imports (`@/...`) stop the walk too; iris-web resolves them through
 * Vite, and naming the map here would duplicate it.
 *
 * Usage:
 *   node notes/test-coverage-blindspots.mjs
 *
 * @module notes/test-coverage-blindspots
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

const ROOT = process.cwd()

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git' || name === 'dist' || name === 'public') continue
    const full = join(dir, name)
    const stat = statSync(full)
    if (stat.isDirectory()) walk(full, out)
    else out.push(full)
  }
  return out
}

/** Every static/dynamic import specifier the file mentions. */
function specifiersOf(file) {
  const text = readFileSync(file, 'utf8')
  const specifiers = []
  const patterns = [
    /(?:^|[\s;}])(?:import|export)\s[^;]*?from\s*['"]([^'"]+)['"]/g,
    /(?:^|[\s;}])import\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /(?:^|[\s;}])import\s*['"]([^'"]+)['"]/g,
    /(?:^|[\s;}])require\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ]
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) specifiers.push(match[1])
  }
  return specifiers
}

const RESOLVE_SUFFIX = ['', '.ts', '.tsx', '.mts', '.js', '.mjs', '/index.ts', '/index.tsx']
function resolveRelative(fromFile, specifier) {
  if (!specifier.startsWith('.')) return undefined
  const base = resolve(dirname(fromFile), specifier)
  for (const suffix of RESOLVE_SUFFIX) {
    if (existsSync(base + suffix) && statSync(base + suffix).isFile()) return base + suffix
  }
  return undefined
}

const report = []
for (const domain of ['packages', 'apps']) {
  for (const entry of readdirSync(join(ROOT, domain))) {
    const pkgDir = join(ROOT, domain, entry)
    if (!statSync(pkgDir).isDirectory()) continue
    let srcDir, testDir
    try {
      srcDir = join(pkgDir, 'src'); testDir = join(pkgDir, 'tests')
      statSync(srcDir); statSync(testDir)
    } catch { continue }

    const srcFiles = walk(srcDir).filter(f => /\.(ts|tsx|mts|js|mjs)$/.test(f))
    const testFiles = walk(testDir).filter(f => /\.(ts|tsx|mts)$/.test(f))
    if (srcFiles.length === 0) continue

    // Import closure from the test files over src files of this package.
    const srcSet = new Set(srcFiles)
    const reachable = new Set()
    const queue = [...testFiles]
    while (queue.length > 0) {
      const file = queue.pop()
      if (reachable.has(file)) continue
      reachable.add(file)
      for (const specifier of specifiersOf(file)) {
        const target = resolveRelative(file, specifier)
        if (target !== undefined && srcSet.has(target) && !reachable.has(target)) queue.push(target)
      }
    }

    const unreachable = srcFiles.filter(f => !reachable.has(f))
    report.push({
      pkg: `${domain}/${entry}`,
      src: srcFiles.length,
      tests: testFiles.length,
      uncovered: unreachable.map(f => relative(pkgDir, f).split('\\').join('/')),
    })
  }
}

let total = 0
let uncoveredTotal = 0
for (const row of report) {
  total += row.src
  uncoveredTotal += row.uncovered.length
  const flag = row.uncovered.length === 0 ? '' : `  UNREACHABLE(${row.uncovered.length}): ${row.uncovered.join(', ')}`
  console.log(`${row.pkg.padEnd(42)} src ${String(row.src).padStart(3)}  test-files ${String(row.tests).padStart(3)}${flag}`)
}
console.log(`\nTOTAL src files ${total}, unreachable from tests ${uncoveredTotal}`)
