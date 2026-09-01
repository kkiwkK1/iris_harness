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
 * One call, two answers, decided by how long the process had been running. The
 * fix was to reuse `hydrateVariables` rather than write a second walk; this is
 * what stops the next such path being written without one.
 *
 * A hand-maintained classification needs something watching for omissions —
 * the same reasoning as `registration.test.ts`, and the same shape: the table
 * below is the decision, and the count check is what makes a new call site a
 * red line rather than a silent gap.
 */

const SOURCES = ['../src/service.ts', '../src/chats.ts'] as const

/**
 * Every `rebuild` call site, and why it does or does not need hydration.
 *
 * Classified by **whether the mapping is total**: if every line in the rebuilt
 * list has a source index, the tables travel with them and nothing else is
 * needed. If any line can have no source, its table has to be put back.
 */
const CLASSIFIED = [
  {
    where: 'chats.ts — branch, parent',
    total: true,
    why: 'identity mapping; the parent keeps every line it had, only `extra.branches` changed',
  },
  {
    where: 'service.ts — createChatMessages',
    total: false,
    why: 'created lines have no predecessor, so their tables must be reattached',
  },
  {
    where: 'service.ts — deleteChatMessages',
    total: true,
    why: 'survivors only; every kept line names the index it came from',
  },
  {
    where: 'service.ts — chat.deleteMessage',
    total: true,
    why: 'survivors only, one hole',
  },
  {
    where: 'service.ts — template write-back',
    total: true,
    why: 'identity mapping; only `mes` is rewritten',
  },
  {
    where: 'service.ts — rewriteLines',
    total: true,
    why: 'identity mapping; only `mes` is rewritten',
  },
] as const

/** Call sites that put tables back, whatever their rebuild does. */
const HYDRATION_SITES = [
  'chats.ts — open, after importing a file',
  'chats.ts — branch, child session',
  'service.ts — createChatMessages',
] as const

async function occurrences(needle: string): Promise<number> {
  let total = 0
  for (const source of SOURCES) {
    const text = await readFile(new URL(source, import.meta.url), 'utf8')
    total += text.split(needle).length - 1
  }
  return total
}

test('every rebuild call site has been classified', async () => {
  const found = await occurrences('.rebuild(')

  // The number, not the reasoning, is what a new call site moves. When this
  // fails, the fix is to decide whether the new rebuild's mapping is total and
  // add it to `CLASSIFIED` — not to bump the count.
  assert.equal(
    found,
    CLASSIFIED.length,
    `${String(found)} rebuild call sites, ${String(CLASSIFIED.length)} classified. `
    + 'A new one must be classified: is its index mapping total? If any rebuilt line can '
    + 'have no source index, its variable table has to be reattached with '
    + '`hydrateVariables`, or it will reach the file but not the live log — and the same '
    + 'read will then answer differently before and after a reload.',
  )
})

test('every hydration call site has been classified', async () => {
  // Call sites only — the method is defined in `entry.ts`, which is not scanned.
  // The first version of this subtracted one for a definition that is not in
  // these files, which is the kind of arithmetic that produces a guard off by
  // exactly one forever.
  const found = await occurrences('hydrateVariables(')
  assert.equal(
    found,
    HYDRATION_SITES.length,
    'a `hydrateVariables` call site was added or removed without updating this list',
  )
})

test('exactly one classified rebuild has a partial mapping, and it hydrates', () => {
  // The cross-check between the two tables. A rebuild whose mapping is not
  // total must appear in both lists; if a second partial one is ever added and
  // its author forgets the hydration, this is what says so.
  const partial = CLASSIFIED.filter(site => !site.total)
  assert.deepEqual(
    partial.map(site => site.where),
    ['service.ts — createChatMessages'],
    'a rebuild with a partial mapping changed — check it reattaches variable tables',
  )
  for (const site of partial) {
    assert.ok(
      HYDRATION_SITES.some(hydration => hydration === site.where),
      `${site.where} rebuilds with a partial mapping but does not hydrate`,
    )
  }
})

test('the classification says something — every entry carries a reason', () => {
  // A list of names with no reasons decays into a list of names. The reason is
  // what a later reader needs in order to classify their own call site, and it
  // is the part that cannot be reconstructed from the code.
  for (const site of CLASSIFIED) {
    assert.ok(site.why.length > 20, `${site.where} has no usable reason recorded`)
  }
})
