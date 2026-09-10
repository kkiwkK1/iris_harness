/**
 * The Tavern Helper surface list, checked against the source it is now
 * extracted from — upstream's **registration table**, not its `@types`.
 *
 * The list began its life read off the installed extension's `@types`, and that
 * source had a failure mode the declarations make invisible: upstream
 * *registers* members the declarations never state. `setChatMessage` was one —
 * real in `src/function/chat_message.ts:492`, injected into every card frame by
 * the table this test reads, absent from `@types` — and a real card
 * (魔法少女的扣扣审判1.0's 封面 regex) met it as `setChatMessage is not
 * defined`, a sentence no checklist could produce because the name was on no
 * list. The source moved to the table the frames are actually seeded from, and
 * this test is the pin that claim stands on: re-extract, and compare, both
 * directions.
 *
 * @module iris-web/tests/upstream-registration
 */
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { UPSTREAM_MEMBERS } from '../src/sandbox/upstream-surface.ts'

/**
 * The injection table's keys, read out of upstream's own source.
 *
 * The table is the object literal `getTavernHelper()` returns
 * (`src/function/index.ts`); `predefine.js` merges all of it into a frame
 * except `_bind`, whose keys it strips one leading underscore from and binds.
 * The extraction therefore walks the literal tracking nesting depth — the two
 * nested objects are `_th_impl` (internal, kept by the merge but private to
 * upstream's own plumbing) and `_bind` (remapped, so its keys are surface
 * names under another spelling).
 * @param source - `src/function/index.ts`.
 * @returns the registered names, in source order, deduplicated.
 */
function registeredNames(source: string): string[] {
  const lines = source.split(/\r?\n/)
  const start = lines.findIndex(line => line.includes('function getTavernHelper()'))
  assert.ok(start !== -1, 'getTavernHelper() not found — the extractor has stopped working')
  const top: string[] = []
  const bind: string[] = []
  let depth = 0
  let inBind = -1
  let inThImpl = -1
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]!.replace(/\/\/.*$/, '').trim()
    const opens = (line.match(/{/g) ?? []).length
    const closes = (line.match(/}/g) ?? []).length
    let key: string | null = null
    const labelled = line.match(/^([A-Za-z_$][A-Za-z0-9_$]*)\s*[,:]/)
    if (labelled !== null) key = labelled[1] as string
    else if (/^[A-Za-z_$][A-Za-z0-9_$]*,$/.test(line)) key = line.slice(0, -1)
    if (key !== null && depth >= 1) {
      if (inBind >= 0) bind.push(key.replace('_', ''))
      else if (inThImpl < 0 && key !== '_th_impl' && key !== '_bind') top.push(key)
    }
    if (key === '_th_impl' && inThImpl < 0) inThImpl = depth + opens
    if (key === '_bind' && inBind < 0) inBind = depth + opens
    depth += opens - closes
    if (inThImpl > 0 && depth < inThImpl) inThImpl = -1
    if (inBind > 0 && depth < inBind) inBind = -1
    if (depth === 0 && closes > 0) break
  }
  // predefine.js picks six library globals from the host page and defines two
  // frame globals of its own. The four here are API namespaces a card calls;
  // `YAML`, `showdown`, `toastr` and `z` are libraries, enumerated where the
  // frame's own missing-globals report reads them (`preset-globals.ts`), and
  // deliberately not on the Tavern Helper list.
  return [...new Set([...top, ...bind, 'EjsTemplate', 'Mvu', 'SillyTavern', 'TavernHelper'])]
}

test('the surface list is exactly what upstream registers', t => {
  const path =
    `${process.env['IRIS_CORPUS'] ?? 'E:/sillyTavern/SillyTavern'}` +
    '/data/default-user/extensions/JS-Slash-Runner/src/function/index.ts'
  let source: string
  try {
    source = readFileSync(path, 'utf8')
  } catch {
    t.skip(`no local Tavern Helper install at ${path}; the registration surface is unverified here`)
    return
  }

  const extracted = registeredNames(source)

  // The floor first: a broken extractor answers *short*, and a short list
  // against a long one reads like upstream withdrew its API rather than like
  // our regex died.
  assert.ok(
    extracted.length > 100,
    `only ${String(extracted.length)} names extracted from ${path} — the extractor has stopped working,`
      + ' and nothing about upstream should be concluded from this run until it is repaired',
  )

  /*
   * Direction one — the gap that cost a card its enter button. Every name the
   * table registers must be on the list, because a name off the list is a name
   * every absence report is allowed to call the card's own fault.
   */
  const listed = new Set(UPSTREAM_MEMBERS)
  const unlisted = extracted.filter(name => !listed.has(name))
  assert.deepEqual(
    unlisted,
    [],
    'upstream registers names the surface list has never heard of — the setChatMessage'
      + ' shape again: a card calling one meets "X is not defined" with no sentence naming'
      + ' it as expected scope. Add the names, and read their upstream source for what they do',
  )

  /*
   * Direction two — a list can also rot the other way, carrying names the
   * table does not register. Exactly two are known, both the declarations'
   * doing rather than the table's: the `@types` spell `getExtensionInstallationInfo`
   * where the table registers `getExtensionStatus`, and declare
   * `placeholder_prompt_default_order` where the table registers the value as
   * `builtin_prompt_default_order`. They stay listed — a card written against
   * the declarations still reaches for them — and this assertion is what keeps
   * the exception two names instead of a habit.
   */
  const registered = new Set(extracted)
  const unregistered = UPSTREAM_MEMBERS.filter(name => !registered.has(name))
  assert.deepEqual(
    unregistered.sort(),
    ['getExtensionInstallationInfo', 'placeholder_prompt_default_order'],
    'the surface list has drifted from the registration table in the other direction —'
      + ' names no frame ever receives. Fold each into the pair of sets above or remove it,'
      + ' with the reason written where the name stays',
  )
})
