/**
 * The `getContext()` surface list, checked against the source it was extracted
 * from — and against the two calipers that read the file it lives in.
 *
 * `UPSTREAM_CONTEXT_MEMBERS` exists so a card reading a member Iris has not
 * built is told which kind of absence it met: upstream's scope that this port
 * has not reached, or a name nothing anywhere carries. That distinction is only
 * as good as the list, and a hand-kept list of 145 names rots silently — the
 * rot invisible until a card is handed the wrong diagnosis, which is the exact
 * sentence `upstream-surface.ts` opens with about the other list.
 *
 * So: re-extract, and compare. Two things are pinned here, and they fail for
 * different reasons.
 *
 * @module iris-web/tests/upstream-context
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { UPSTREAM_CONTEXT_MEMBERS, UPSTREAM_MEMBERS } from '../src/sandbox/upstream-surface.ts'

/**
 * The keys `getContext()` returns, read out of upstream's own source.
 *
 * **A deliberately different mechanism from the caliper that first counted
 * them.** `scripts/st-context-audit.mjs` (retired with its branch on 2026-09-11;
 * frozen at PR #51's head `c91d7b5`) walks the file character by character,
 * tracking brace depth and skipping
 * strings and both comment forms. This one keys on **indentation**: the
 * returned literal's own members sit at four levels of two spaces, anything
 * nested sits deeper, and the `@deprecated` blocks between keys begin with `*`
 * or `/`. Two mechanisms that could not fail the same way agreeing on 145 names
 * is why that number is quoted rather than hedged — a shared habit between two
 * readings corroborates nothing over the layer they share.
 * @param source - `public/scripts/st-context.js`.
 * @returns the key names, in source order.
 */
function contextKeys(source: string): string[] {
  const at = source.indexOf('export function getContext()')
  if (at === -1) return []
  const body = source.slice(source.indexOf('return {', at))
  // The literal's own closing brace: `    };` at the function's indentation.
  const end = body.indexOf('\n    };')
  const inner = end === -1 ? body : body.slice(0, end)
  const names: string[] = []
  for (const line of inner.split('\n')) {
    const hit = /^ {8}([A-Za-z_$][A-Za-z0-9_$]*)\s*[,:]/.exec(line)
    if (hit !== null) names.push(hit[1] as string)
  }
  return names
}

test('the getContext surface is still the surface upstream returns', (t) => {
  /*
   * Skipped rather than failed where the install is absent: it is one machine's
   * SillyTavern, and a test that cannot see it has learned nothing either way —
   * the same gate `tavern-helper.test.ts` uses for the Tavern Helper manifest.
   */
  const path = `${process.env['IRIS_CORPUS'] ?? 'E:/sillyTavern/SillyTavern'}/public/scripts/st-context.js`
  let source: string
  try {
    source = readFileSync(path, 'utf8')
  } catch {
    t.skip(`no local SillyTavern install at ${path}; the 145-key list is unverified here`)
    return
  }

  const extracted = contextKeys(source)

  /*
   * The floor first, and before the comparison rather than after it. A broken
   * extractor answers with a *short* list, and a short list compared against a
   * long one fails with a diff hundreds of lines long that reads like upstream
   * removed most of its API — the wrong conclusion, reached confidently. Saying
   * "the extractor stopped working" is a different sentence and it is the true
   * one.
   */
  assert.ok(
    extracted.length > 100,
    `only ${String(extracted.length)} keys extracted from ${path} — the extractor has stopped working,`
    + ' and nothing about upstream should be concluded from this run until it is repaired',
  )

  assert.deepEqual(
    [...extracted].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    [...UPSTREAM_CONTEXT_MEMBERS],
    'upstream’s getContext() and our copy of its key list have come apart —'
    + ' re-extract rather than editing one name, because a card reaching for a key'
    + ' missing from the list gets the wrong diagnosis, not an error',
  )
})

test('reading this file the way the calipers do still finds only the Tavern Helper list', () => {
  /*
   * A guard over a hazard that is invisible in every other way, and that this
   * change created.
   *
   * `scripts/th-member-census.mjs` in this tree (and `scripts/th-surface-audit.mjs`
   * did too, until its branch was retired on 2026-09-11) locates the Tavern
   * Helper list by searching `upstream-surface.ts` for its name and then
   * matching **every quoted identifier to the end of the file**. Adding a second
   * name array to that file is therefore a way to break the caliper without
   * touching it: its surface silently becomes 316 names, most of which then report as "declared
   * but never used" — which reads as a finding rather than as a broken
   * extractor, so nobody would go looking.
   *
   * Two properties keep it safe, and neither is visible at the point where
   * someone would break it: the context list is declared **first**, and the
   * file's prose above it does not spell the other list's name (the search takes
   * the first occurrence, comment text included). This asserts the outcome of
   * both, so a future edit that reorders the arrays or mentions the name in a
   * new paragraph goes red here instead of quietly moving a number in a report.
   */
  const source = readFileSync(new URL('../src/sandbox/upstream-surface.ts', import.meta.url), 'utf8')
  const from = source.indexOf('UPSTREAM_MEMBERS')
  assert.ok(from > 0, 'the Tavern Helper list is no longer findable by name in upstream-surface.ts')

  const asCalipersSee = [...source.slice(from).matchAll(/'([A-Za-z_$][A-Za-z0-9_$]*)'/g)].map(
    match => match[1] as string,
  )
  assert.deepEqual(
    asCalipersSee,
    [...UPSTREAM_MEMBERS],
    'a caliper reading this file gets a different surface than the module exports —'
    + ' the usual cause is a second array declared after UPSTREAM_MEMBERS, or its name'
    + ' written in prose above the context list',
  )
})

test('the two surfaces are separate lists, and the overlap is real rather than a paste', () => {
  /*
   * They share names — `generate`, `generateRaw`, `saveChat`, `event_types` — and
   * that is upstream's own doing: Tavern Helper wraps parts of the SillyTavern
   * context under the same spelling. What must not happen is one list being a
   * copy of the other, which is what a bad merge or a stray editor multi-cursor
   * produces, and which would make the facade's report cite the wrong authority
   * for every name in the difference.
   */
  const context = new Set(UPSTREAM_CONTEXT_MEMBERS)
  const shared = UPSTREAM_MEMBERS.filter(name => context.has(name))
  assert.ok(shared.length > 0, 'no name at all is on both surfaces, which upstream is not')
  assert.ok(
    shared.length < UPSTREAM_MEMBERS.length / 2,
    `${String(shared.length)} of ${String(UPSTREAM_MEMBERS.length)} Tavern Helper names are also getContext keys`
    + ' — at that overlap one list has been pasted over the other',
  )
})
