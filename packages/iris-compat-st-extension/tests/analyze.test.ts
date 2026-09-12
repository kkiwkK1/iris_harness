import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'

import { analyzeStExtension } from '../src/analyze.ts'
import type { CompatibilityFinding } from '../src/report.ts'

/**
 * The analyzer's honesty rules, pinned on a fixture small enough to hold in
 * your head: every arm of §6's first slice must appear exactly once with the
 * result the rules demand — mapped only for exact registered hits, unknown
 * for everything not statically decidable, missing only for affirmative
 * absence.
 */

const FIXTURES = join(import.meta.dirname, '../../../tests/fixtures/st-extensions')
const VIRTUAL_ROOT = 'scripts/extensions/third-party/minimal-ok'

/** category:name:result triples, sorted, for set comparison without order coupling. */
function keys(findings: readonly CompatibilityFinding[]): string[] {
  return findings.map(f => `${f.category}:${f.name}:${f.result}`).sort()
}

test('the minimal fixture produces exactly the expected findings', async () => {
  const outcome = await analyzeStExtension({ root: join(FIXTURES, 'minimal-ok'), virtualRoot: VIRTUAL_ROOT })
  assert.ok(outcome.ok)
  assert.deepEqual(keys(outcome.report.findings), [
    'dom:/scripts/extensions/third-party/minimal-ok/src/worker.js:unknown',
    'dom:import.meta:unknown',
    'dynamic:import(<expression>):unknown',
    'http:../img/bg.png:unknown',
    'http:https://example.com/framework.css:unknown',
    // host modules resolve exactly at their true depths
    'module:../../../../../script.js:mapped',
    'module:../../../../events.js:mapped',
    // bare specifier: an import-map decision, not an absence
    'module:left-pad:unknown',
  ])
  // own-file edges enter the graph instead of the findings — including the
  // literal dynamic import's target
  assert.deepEqual(outcome.report.files, [
    'css/style.css',
    'manifest.json',
    'src/entry.js',
    'src/lazy.js',
    'src/re-export.js',
    'src/util.js',
  ])
  assert.equal(outcome.report.verdict, 'unverified', 'the analyzer never claims more than it measured')
  assert.deepEqual(outcome.report.manifestUnknownFields, [])
  // every finding carries a 1-based line — the AST knows, so the report must
  for (const finding of outcome.report.findings) {
    assert.ok(finding.line !== undefined && finding.line >= 1, `${finding.name} lost its line`)
  }
})

test('the content digest is stable for a tree and moves when the tree moves', async () => {
  const root = join(FIXTURES, 'minimal-ok')
  const first = await analyzeStExtension({ root, virtualRoot: VIRTUAL_ROOT })
  const second = await analyzeStExtension({ root, virtualRoot: VIRTUAL_ROOT })
  assert.ok(first.ok && second.ok)
  assert.equal(first.report.contentDigest, second.report.contentDigest)
  assert.equal(first.report.analyzerVersion, second.report.analyzerVersion)
})

test('a broken graph reports affirmative absence, not silence', async () => {
  const outcome = await analyzeStExtension({ root: join(FIXTURES, 'broken-graph'), virtualRoot: 'scripts/extensions/third-party/broken-graph' })
  assert.ok(outcome.ok)
  assert.deepEqual(keys(outcome.report.findings), [
    'module:../../../../../extensions/world-info.js:unknown',
    'module:../../../../made-up.js:missing',
    // the absent own target is named by the walk, artifact-relative
    'module:src/absent.js:missing',
  ])
  // the absent target is reported against itself — a person looking for the
  // gap is pointed at the missing file, not only at the importer
  const absent = outcome.report.findings.find(finding => finding.name === 'src/absent.js')
  assert.ok(absent !== undefined)
  assert.equal(absent.file, 'src/absent.js')
})

test('a near-miss is unknown with the candidate named, never a guess', async () => {
  const outcome = await analyzeStExtension({
    root: join(FIXTURES, 'broken-graph'),
    virtualRoot: 'scripts/extensions/third-party/broken-graph',
  })
  assert.ok(outcome.ok)
  const nearMiss = outcome.report.findings.find(finding => finding.name === '../../../../../extensions/world-info.js')
  assert.ok(nearMiss !== undefined)
  assert.equal(nearMiss.result, 'unknown')
  assert.match(nearMiss.reason, /scripts\/world-info\.js/)
})

test('a manifest declaring an escaping entry is refused before any file opens', async () => {
  const outcome = await analyzeStExtension({ root: join(FIXTURES, 'nonexistent'), virtualRoot: 'x' })
  assert.ok(!outcome.ok)
  assert.match(outcome.error, /manifest\.json is not readable/)
})
