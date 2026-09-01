import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'

import { decodeCardPng, normalizeCard, type CharacterCard } from '@iris/character'
import { extractScripts } from '@iris/script'

/**
 * The premise under which this host emits no `VARIABLE_UPDATE_ENDED`.
 *
 * `DEVIATIONS.md §3` records the decision: the host's fold path does not emit
 * the event, because every card that listens to it ships the MagVarUpdate bundle
 * itself, and the bundle emits it from its own trunk. A second emitter would
 * fire an **interception** twice — the listener mutates the variables and the
 * framework keeps the mutation, so running it on its own output applies the
 * correction twice. Absence keeps those cards working; a helpful round trip
 * breaks them.
 *
 * That decision rests entirely on a fact about the corpus, and a fact about the
 * corpus is exactly the kind of premise that stops being true without anyone
 * noticing. So it is asserted rather than cited: a card that listens without
 * shipping the bundle fails this test and sends the reader to the deviation it
 * invalidates.
 *
 * Written as a test rather than as a line in a census because the failure has to
 * find the reader. Nobody re-runs a census to check an assumption they have
 * stopped thinking about.
 */

const CORPUS = `${process.env['IRIS_CORPUS'] ?? 'E:/sillyTavern/SillyTavern'}/data/default-user/characters`
const hasCorpus = existsSync(CORPUS)

/**
 * The event's wire name, spelled as upstream spells it.
 *
 * `VARIABLE_INITIALIZED` in the same table is `'mag_variable_initiailized'` —
 * `i-n-i-t-i-a-i-l`, a typo in upstream that this host copies verbatim on the
 * `substidudeMacros` precedent. A correctly spelled constant reaches no
 * listener at all, so the misspelling is the compatible spelling.
 */
const UPDATE_ENDED = 'mag_variable_update_ended'
const INITIALIZED = 'mag_variable_initiailized'

/** Counted by splitting: these names carry no regex metacharacters, and building a pattern for them is how two earlier counts went wrong. */
const occurrences = (haystack: string, needle: string): number => haystack.split(needle).length - 1

/** Every script a card ships, as one string. */
function scriptTextOf(card: CharacterCard): string {
  return extractScripts(card).scripts.map(script => script.content).join('\n')
}

/** Does this text register a listener for the end-of-update event? */
function listensForUpdateEnded(text: string): number {
  return occurrences(text, UPDATE_ENDED) + occurrences(text, 'VARIABLE_UPDATE_ENDED')
}

/** Does this text bring the bundle that emits it? */
function shipsBundle(text: string): boolean {
  return text.includes('MagVarUpdate')
}

test('the event names are upstream’s, misspelling included', () => {
  // Pinned as literals so that "fixing" the typo is a test failure rather than a
  // silent loss of every listener. Upstream's own declaration file is the
  // source: `JS-Slash-Runner/@types/iframe/exported.mvu.d.ts`.
  assert.equal(INITIALIZED, 'mag_variable_initiailized')
  assert.notEqual(INITIALIZED, 'mag_variable_initialized')
  assert.equal(UPDATE_ENDED, 'mag_variable_update_ended')
})

test('the detector speaks — it finds a listener that ships no bundle', () => {
  // An instrument that only reports exceptions has unfalsifiable silence: a
  // green run below could mean "no such card exists" or "the detector is
  // broken", and those need telling apart. This proves it can say yes.
  const consumerOnly = `eventOn(Mvu.events.${'VARIABLE_UPDATE_ENDED'}, v => v)`
  assert.ok(listensForUpdateEnded(consumerOnly) > 0)
  assert.equal(shipsBundle(consumerOnly), false)

  const withBundle = `${consumerOnly}\nawait import('https://cdn.jsdelivr.net/gh/MagicalAstrogy/MagVarUpdate@x/bundle.js')`
  assert.ok(listensForUpdateEnded(withBundle) > 0)
  assert.equal(shipsBundle(withBundle), true)
})

test('every card that listens for the end of an update ships the bundle', { skip: !hasCorpus }, async () => {
  const offenders: string[] = []
  let listeners = 0

  for (const file of await readdir(CORPUS)) {
    let card: CharacterCard
    try {
      card = file.endsWith('.png')
        ? normalizeCard(decodeCardPng(await readFile(join(CORPUS, file))))
        : file.endsWith('.json')
          ? normalizeCard(JSON.parse(await readFile(join(CORPUS, file), 'utf8')) as unknown)
          : (() => { throw new Error('not a card') })()
    } catch { continue }

    const text = scriptTextOf(card)
    if (listensForUpdateEnded(text) === 0) continue
    listeners += 1
    if (!shipsBundle(text)) offenders.push(file)
  }

  // Measured 2026-09-02: 4 cards listen, 4 ship the bundle. The count is dated;
  // the property is not, and it is the property the deviation rests on.
  assert.ok(listeners > 0, 'no card listens for this event — the premise may no longer be measurable')
  assert.deepEqual(
    offenders,
    [],
    'these cards listen for VARIABLE_UPDATE_ENDED without shipping the bundle that emits it, '
    + 'so on the host fold path their listeners never run. DEVIATIONS.md §3 assumes this list is '
    + 'empty; with it non-empty the only correct fix is the full round trip — host broadcasts both '
    + 'trees, the frame runs the listeners, the host adopts what they returned. A notification-only '
    + 'forward would run the card’s correction, look successful, and throw the result away.',
  )
})
