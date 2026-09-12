#!/usr/bin/env node
/**
 * Read-only survey of one locally installed SillyTavern extension directory.
 *
 * P0 deliverable (`docs/ST-EXTENSION-DESIGN-AND-RUNBOOK.md` §9 batch P0:
 * 只读勘察脚本). It reads the extension's manifest and built entry, hashes the
 * bytes, inventories the tree, and extracts **static** import specifiers with
 * a regex — the first, cheap pass. The real module graph (P2) must use a JS
 * parser; this script's import list is evidence, not proof, and every
 * specifier it cannot resolve is reported as unknown rather than guessed.
 *
 * Contract:
 *  - reads only: the extension tree and (for host-module resolution) the ST
 *    `public/` tree. Never writes, never executes, never fetches.
 *  - writes exactly one file: the report given via `--out`, else stdout.
 *  - no secrets: it never touches anything outside the two roots it is given.
 *
 * Usage:
 *   node survey-st-extension.mjs <extension-dir> [--st-root <st-public-dir>] [--out report.json]
 *
 * `<st-public-dir>` defaults to the local fact source
 * `E:/sillyTavern/SillyTavern/public` (read-only; `docs/ST-EXTENSION-DESIGN-AND-RUNBOOK.md` §2).
 */

import { createHash } from 'node:crypto'
import { readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'

/** Fields SillyTavern 1.18.0's `public/scripts/extensions.js` actually reads. */
const KNOWN_MANIFEST_FIELDS = [
  // `extensions.js:429,782,814` — entry assets
  'js', 'css',
  // `extensions.js:49-50` — ordering
  'loading_order', 'display_name',
  // `extensions.js:578-586` — enable conditions (requires → Extras modules,
  // dependencies → other extensions, minimum_client_version → CLIENT_VERSION)
  'requires', 'dependencies', 'minimum_client_version',
  // `extensions.js:972-986` — displayed requirement chips
  'optional',
  // `extensions.js:849-855` — locale files
  'i18n',
  // install/update path (`extensions.js:1764`, update checks read the repo)
  'author', 'version', 'homePage', 'auto_update',
]

/** A plausible module specifier: no spaces, parens, colons or operators. */
const SPECIFIER_RE = /^[A-Za-z0-9@/_.-]+$/

function parseArgs(argv) {
  const positional = []
  let stRoot = 'E:/sillyTavern/SillyTavern/public'
  let out = undefined
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--st-root') stRoot = argv[++i]
    else if (argv[i] === '--out') out = argv[++i]
    else positional.push(argv[i])
  }
  if (positional.length !== 1) {
    console.error('usage: survey-st-extension.mjs <extension-dir> [--st-root <dir>] [--out report.json]')
    process.exit(2)
  }
  return { extensionDir: resolve(positional[0]), stRoot: resolve(stRoot), out }
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

/** Walk one tree read-only; `visit` receives each file's absolute path. */
async function walk(root, visit) {
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return // unreadable subtree is reported by its absence, not by a crash
  }
  for (const entry of entries) {
    // A junction or symlink pointing outward would make "inside the
    // extension" a lie; skip anything that is not a plain file or dir.
    if (entry.isSymbolicLink()) continue
    const full = join(root, entry.name)
    if (entry.isDirectory()) await walk(full, visit)
    else if (entry.isFile()) await visit(full)
  }
}

/** Every path suffix of `p`'s segments, shortest first, for suffix matching. */
function suffixes(p) {
  const parts = p.split(sep).filter(part => part !== '' && part !== '.')
  const out = []
  for (let i = 0; i < parts.length; i++) out.push(parts.slice(i).join('/'))
  return out
}

/**
 * Build the host-module index: file paths under `<st-root>` (JS only, depth
 * capped so a huge tree stays cheap), keyed by each suffix of their
 * repo-relative path. `script.js` therefore indexes both `script.js` (the
 * host root module) and any deeper `…/script.js`; ambiguity is preserved
 * instead of resolved, because this survey must not guess.
 */
async function buildHostIndex(stRoot) {
  const index = new Map()
  const cap = 6
  async function visit(dir, depth) {
    if (depth > cap) return
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) await visit(full, depth + 1)
      else if (entry.isFile() && /\.(m?js|css)$/.test(entry.name)) {
        for (const suffix of suffixes(relative(stRoot, full))) {
          const list = index.get(suffix) ?? []
          list.push(relative(stRoot, full).split(sep).join('/'))
          index.set(suffix, list)
        }
      }
    }
  }
  await visit(stRoot, 0)
  return index
}

/** Classify one specifier and resolve it as far as honesty allows. */
function classify(raw, ownFiles, hostIndex) {
  let kind
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw)) kind = 'url'
  else if (raw.startsWith('/')) kind = 'root-absolute'
  else if (raw.startsWith('./') || raw.startsWith('../')) kind = 'relative'
  else kind = 'bare'
  if (kind !== 'relative') return { raw, kind, matches: [], ambiguous: false }

  // The bundle preserves the ORIGINAL source specifier, whose `../` depth
  // belonged to a source file we do not have, so the depth is not resolvable.
  // What survives truthfully is the tail: the path after the leading `../`
  // run. That tail is matched as a suffix against the extension tree and the
  // ST host tree; multiple matches stay ambiguous.
  const tail = raw.replace(/^(?:\.\.\/)+/, '')
  const matches = []
  if (hostIndex.has(tail)) matches.push(...hostIndex.get(tail).map(path => `st:${path}`))
  // The extension's own files claim the tail only when that exact tail path
  // exists under the extension root (e.g. `libs/faker.mjs`).
  if (ownFiles.has(tail)) matches.push(`own:${tail}`)
  return { raw, kind, matches, ambiguous: matches.length !== 1, tail }
}

async function main() {
  const { extensionDir, stRoot, out } = parseArgs(process.argv.slice(2))
  const notes = []
  const report = {
    surveyVersion: 1,
    generatedAt: new Date().toISOString(),
    extensionDir,
    stRoot,
    manifest: undefined,
    tree: undefined,
    entry: undefined,
    imports: undefined,
    notes,
  }

  // ---- manifest -----------------------------------------------------------
  const manifestBytes = await readFile(join(extensionDir, 'manifest.json'))
  const manifest = JSON.parse(manifestBytes.toString('utf8'))
  const unknownFields = Object.keys(manifest).filter(key => !KNOWN_MANIFEST_FIELDS.includes(key))
  report.manifest = {
    path: 'manifest.json',
    sha256: sha256(manifestBytes),
    fields: manifest,
    unknownFields,
    knownFields: KNOWN_MANIFEST_FIELDS.filter(key => key in manifest),
  }
  if (unknownFields.length > 0) notes.push(`manifest fields outside the ST 1.18.0 read list: ${unknownFields.join(', ')}`)

  // ---- tree inventory -----------------------------------------------------
  const topLevel = new Map()
  const ownFiles = new Set()
  let totalFiles = 0
  let totalBytes = 0
  const workers = []
  await walk(extensionDir, async full => {
    const info = await stat(full)
    const rel = relative(extensionDir, full).split(sep).join('/')
    ownFiles.add(rel)
    const bucket = rel.includes('/') ? rel.split('/')[0] : '(root)'
    const row = topLevel.get(bucket) ?? { files: 0, bytes: 0 }
    row.files++
    row.bytes += info.size
    topLevel.set(bucket, row)
    totalFiles++
    totalBytes += info.size
    if (/(^|[/.-])workers?([.-]|\.js$)/.test(rel) && rel.endsWith('.js')) workers.push({ path: rel, bytes: info.size })
  })
  report.tree = {
    totalFiles,
    totalBytes,
    topLevel: [...topLevel.entries()].sort((a, b) => b[1].bytes - a[1].bytes)
      .map(([name, row]) => ({ name, ...row })),
  }
  report.workers = workers
  if (workers.length > 0) notes.push(`Worker scripts present (${workers.map(w => w.path).join(', ')}): Worker/fetch relative paths need their own verification (runbook §6)`)

  // ---- entry --------------------------------------------------------------
  const entryRel = manifest.js
  if (typeof entryRel !== 'string' || entryRel === '') throw new Error('manifest has no js entry')
  const entryPath = resolve(extensionDir, entryRel)
  const entryBytes = await readFile(entryPath)
  const entryText = entryBytes.toString('utf8')
  report.entry = { path: entryRel, sha256: sha256(entryBytes), bytes: entryBytes.length }

  // `new Worker("…")` with a string literal: an absolute one is baked by the
  // build against the ST URL layout — the single most layout-coupled thing a
  // bundle can do, so it gets its own list rather than hiding in `notes`.
  const workerSites = []
  for (const match of entryText.matchAll(/new Worker\(\s*(["'])([^"'\n]+)\1/g)) {
    if (!workerSites.includes(match[2])) workerSites.push(match[2])
  }
  report.workerLiteralSites = workerSites

  // ---- static imports (regex pass; the parser pass is P2's job) ----------
  const hostIndex = await buildHostIndex(stRoot)
  const seen = new Map()
  for (const match of entryText.matchAll(/(?:from|import)\s*["']([^"'\n]+)["']/g)) {
    const raw = match[1]
    if (!SPECIFIER_RE.test(raw) || raw.length > 200) continue // parser-source noise, not a specifier
    if (!seen.has(raw)) seen.set(raw, classify(raw, ownFiles, hostIndex))
  }
  const dynamic = []
  for (const match of entryText.matchAll(/import\(\s*["']([^"'\n]+)["']\s*\)/g)) {
    const raw = match[1]
    if (SPECIFIER_RE.test(raw) && !dynamic.includes(raw)) dynamic.push(raw)
  }
  const imports = [...seen.values()]
  report.imports = {
    method: 'regex first pass; P2 must re-derive with a parser (runbook §6)',
    static: imports,
    dynamicLiteral: dynamic,
    unresolved: imports.filter(item => item.kind !== 'relative' || item.matches.length === 0).map(item => item.raw),
  }
  const hostModules = [...new Set(imports.flatMap(item => item.matches.filter(m => m.startsWith('st:')).map(m => m.slice(3))))]
    .sort()
  report.hostModules = hostModules
  notes.push(`resolved host-module candidates: ${hostModules.length}; ambiguous tails are listed per-import, not resolved`)

  const text = JSON.stringify(report, null, 2) + '\n'
  if (out === undefined) process.stdout.write(text)
  else await writeFile(out, text)
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
