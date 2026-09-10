import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

/**
 * Every log rebuild is classified: does it need the variable tables put back?
 *
 * `ChatEntry.rebuild` carries per-candidate variable tables across **by
 * position** — the caller's index mapping says where each new line came from,
 * and a line with no source gets nothing. That is correct for an edit or a
 * deletion, where every surviving line has a predecessor. It is wrong wherever a
 * line arrives from outside the log, because such a line's `variables` are
 * carried as an opaque field and have to be reattached explicitly, which is what
 * `hydrateVariables` does on load.
 *
 * **This has already failed once.** `script.createChatMessages` created lines
 * with tables, the mapping had no source for them, and the tables reached the
 * file but not the live log — so a card appending a floor and reading it back
 * got the *inherited* value, while the same read after a restart got its own.
 *
 * **The guard used to compare counts, and that was not enough.** Six call sites
 * against six classifications passes whether or not the six are the *same* six:
 * add one site while deleting an unrelated classification and the totals still
 * agree. The labels were prose, checked by nobody — one of them said "template
 * write-back" where the code says `#storeRewritten`, and nothing noticed
 * because nothing compared them. A count guard proves the totals match; it says
 * nothing about entry *i* describing site *i*, which is exactly the gap an
 * off-by-one slips through.
 *
 * So the table below is keyed by the **site name derived from the source**, and
 * the check is set equality. A site that appears, moves, or is renamed shows up
 * as a named difference rather than a number.
 */

const SOURCES = [
  { file: 'service.ts', path: '../src/service.ts' },
  { file: 'chats.ts', path: '../src/chats.ts' },
] as const

/**
 * Every `rebuild` call site, keyed by its enclosing site name, and why it does
 * or does not need hydration.
 *
 * Classified by **whether the mapping is total**: if every line in the rebuilt
 * list has a source index, the tables travel with them and nothing else is
 * needed. If any line can have no source, its table has to be put back.
 */
const CLASSIFIED: Record<string, { total: boolean, why: string }> = {
  'branch': {
    total: true,
    why: 'identity mapping; the parent keeps every line it had, only `extra.branches` changed',
  },
  'script.createChatMessages': {
    total: false,
    why: 'created lines have no predecessor, so their tables must be reattached',
  },
  'script.deleteChatMessages': {
    total: true,
    why: 'survivors only; every kept line names the index it came from',
  },
  'chat.deleteMessage': {
    total: true,
    why: 'survivors only, one hole',
  },
  '#storeRewritten': {
    total: true,
    why: 'identity mapping; only `mes` is rewritten, by the template write-back',
  },
  '#rewriteLines': {
    total: true,
    why: 'identity mapping; only `mes` is rewritten',
  },
  // —— family①: identity & messages ——
  'script.rotateChatMessages': {
    total: true,
    why: 'a permutation; every line keeps its identity and the source indices are spliced in step '
      + 'with the lines, which is the whole reason the rotation is a host arm — a frame composing '
      + 'it out of setChatMessages could only have moved the text',
  },
}

/** Call sites that put tables back, whatever their rebuild does. */
const HYDRATION_SITES = ['open', 'branch', 'script.createChatMessages'] as const

/** Lines that look like a declaration but are control flow. */
const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'else', 'do', 'try'])

/**
 * A line that names an enclosing site: an RPC handler key or a method.
 *
 * Derived rather than declared, so the table cannot drift from the code while
 * staying green — the failure this guard exists to make impossible.
 */
const SITE = /^\s*(?:'([\w.]+)':\s*async|(?:async\s+)?([#a-zA-Z][\w]*)\s*\()/

/**
 * Find the site enclosing each occurrence of `needle`.
 * @param needle - the call to locate.
 * @returns site names, one per occurrence.
 */
async function sitesCalling(needle: string): Promise<string[]> {
  const found: string[] = []
  for (const source of SOURCES) {
    const text = await readFile(new URL(source.path, import.meta.url), 'utf8')
    const lines = text.split(String.fromCharCode(10))
    lines.forEach((line, index) => {
      if (!line.includes(needle)) return
      for (let above = index; above >= 0; above -= 1) {
        const match = SITE.exec(lines[above] ?? '')
        if (match === null) continue
        if (match[2] !== undefined && KEYWORDS.has(match[2])) continue
        found.push(match[1] ?? match[2] ?? '?')
        return
      }
      found.push(`(no enclosing site found at ${source.file}:${String(index + 1)})`)
    })
  }
  return found
}

test('the classified sites are exactly the sites that rebuild', async () => {
  const found = new Set(await sitesCalling('.rebuild('))
  const classified = new Set(Object.keys(CLASSIFIED))

  // Set equality, not counts. When this fails it names which site appeared or
  // vanished, and the fix is to decide whether the new one's index mapping is
  // total — not to adjust a number until it matches.
  const unclassified = [...found].filter(site => !classified.has(site)).sort()
  const stale = [...classified].filter(site => !found.has(site)).sort()

  assert.deepEqual(
    unclassified,
    [],
    `these rebuild without a classification: ${unclassified.join(', ')}. `
    + 'Is the new site\'s index mapping total? If any rebuilt line can have no source index, '
    + 'its variable table must be reattached with `hydrateVariables`, or it reaches the file '
    + 'but not the live log — and the same read then answers differently before and after a reload.',
  )
  assert.deepEqual(
    stale,
    [],
    `these are classified but no longer rebuild: ${stale.join(', ')} — the table describes code that moved`,
  )
})

test('the classified hydration sites are exactly the sites that hydrate', async () => {
  const found = new Set(await sitesCalling('hydrateVariables('))
  assert.deepEqual([...found].sort(), [...HYDRATION_SITES].sort())
})

test('exactly one classified rebuild has a partial mapping, and it hydrates', () => {
  // The cross-check between the two tables. A rebuild whose mapping is not
  // total must appear in both; if a second partial one is added and its author
  // forgets the hydration, this is what says so.
  const partial = Object.entries(CLASSIFIED).filter(([, site]) => !site.total).map(([name]) => name)
  assert.deepEqual(partial, ['script.createChatMessages'])
  for (const site of partial) {
    assert.ok(
      (HYDRATION_SITES as readonly string[]).includes(site),
      `${site} rebuilds with a partial mapping but does not hydrate`,
    )
  }
})

test('the classification says something — every entry carries a reason', () => {
  // A list of names with no reasons decays into a list of names. The reason is
  // what a later reader needs in order to classify their own call site, and it
  // is the part that cannot be reconstructed from the code.
  for (const [name, site] of Object.entries(CLASSIFIED)) {
    assert.ok(site.why.length > 20, `${name} has no usable reason recorded`)
  }
})
