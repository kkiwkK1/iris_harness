import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

import { decodeCardPng, normalizeCard, type CharacterCard } from '@iris/character'
import { extractScripts } from '@iris/script'

import { ScriptVariableStore, scriptIdOf } from '../src/script-variables.ts'

/**
 * Where a card script's own variables live, and what that choice costs.
 *
 * SillyTavern writes them into the card file on every change; Iris keeps them
 * beside the installation. `script-variables.ts` carries the upstream citations
 * and the argument. What the tests below are for is the part an argument cannot
 * settle: that the author's shipped values still reach the script, that a
 * player's progress survives a restart, and — the corpus-gated one — that the
 * deviation costs no behaviour on the cards that actually exist.
 */

const CHARACTERS = `${(process.env['IRIS_CORPUS'] ?? 'E:/sillyTavern/SillyTavern')}/data/default-user/characters`

/** A throwaway store. */
async function store(t: TestContext): Promise<{ store: ScriptVariableStore, path: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'iris-script-vars-'))
  t.after(async () => { await rm(dir, { recursive: true, force: true }) })
  const path = join(dir, 'script-variables.json')
  return { store: new ScriptVariableStore(path), path }
}

/** A card carrying one script with the given shipped data. */
function cardWith(data: unknown): CharacterCard {
  return {
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      name: 'Aria', description: '', personality: '', scenario: '',
      first_mes: '', mes_example: '', creator_notes: '', system_prompt: '',
      post_history_instructions: '', alternate_greetings: [], tags: [],
      creator: '', character_version: '1',
      extensions: {
        tavern_helper: {
          scripts: [{ id: 'panel', name: 'Status panel', type: 'script', enabled: true, content: '// x', data }],
        },
      },
    },
  } as unknown as CharacterCard
}

test('a selector with no script id is refused, as upstream refuses it', () => {
  // `JS-Slash-Runner/src/function/variables.ts:85` and `:175` both throw
  // 未指定 script_id. Pooling the ownerless writes into one shared table would
  // let two unidentified callers silently read each other's state — and that
  // table would now be on disk.
  assert.throws(
    () => scriptIdOf({ type: 'script' }),
    (error: unknown) => (error as { code?: string }).code === 'invalid-request',
  )
  assert.equal(scriptIdOf({ type: 'script', script_id: 'panel' }), 'panel')
})

test('the author’s shipped data seeds the table, once', async (t) => {
  const { store: variables } = await store(t)
  const card = cardWith({ 显示错误: '是' })

  const tables = await variables.open('aria', card)
  assert.deepEqual(tables['panel'], { 显示错误: '是' })

  // The script then plays, and writes.
  const backend = variables.backendFor(tables)
  backend.write({ type: 'script', script_id: 'panel' }, { 显示错误: '否', 进度: 7 })
  await variables.settled()

  // Re-opening must not re-seed: the shipped value is a default, and a default
  // that reapplied on every open would undo the player's progress each restart.
  assert.deepEqual((await variables.open('aria', card))['panel'], { 显示错误: '否', 进度: 7 })
})

test('what a script wrote survives a restart', async (t) => {
  const { store: variables, path } = await store(t)
  const tables = await variables.open('aria', undefined)
  variables.backendFor(tables).write({ type: 'script', script_id: 'panel' }, { 进度: 3 })
  await variables.settled()

  // A second store over the same file is what a restart is.
  const reopened = new ScriptVariableStore(path)
  assert.deepEqual((await reopened.open('aria', cardWith({ 进度: 0 })))['panel'], { 进度: 3 })
  // And the file is where the deviation says it is — beside the installation,
  // not inside a card.
  assert.match(await readFile(path, 'utf8'), /"进度": 3/u)
})

test('one card’s script cannot read another card’s table', async (t) => {
  const { store: variables } = await store(t)
  const aria = await variables.open('aria', undefined)
  const other = await variables.open('other', undefined)

  variables.backendFor(aria).write({ type: 'script', script_id: 'panel' }, { mine: true })
  await variables.settled()

  assert.deepEqual(variables.backendFor(other).read({ type: 'script', script_id: 'panel' }), {})
  // Nor another script's, inside the same card.
  assert.deepEqual(variables.backendFor(aria).read({ type: 'script', script_id: 'elsewhere' }), {})
})

test('a deleted character’s partition goes with it', async (t) => {
  const { store: variables, path } = await store(t)
  const tables = await variables.open('aria', undefined)
  variables.backendFor(tables).write({ type: 'script', script_id: 'panel' }, { mine: true })
  await variables.settled()

  await variables.forget('aria')
  // Keyed by character id, so a leftover partition would be inherited by the
  // next card imported under that id.
  assert.equal((await readFile(path, 'utf8')).includes('panel'), false)
})

test('a script cannot store what the file could not hold', async (t) => {
  const { store: variables } = await store(t)
  const backend = variables.backendFor(await variables.open('aria', undefined))
  assert.throws(
    () => backend.write({ type: 'script', script_id: 'panel' }, { when: Number.POSITIVE_INFINITY }),
    (error: unknown) => (error as { code?: string }).code === 'invalid-request',
  )
})

/**
 * The measurement the deviation rests on, run against the real corpus.
 *
 * This is the test that would overturn the decision rather than confirm it: if
 * a card on this machine ever accumulates player progress in `scripts[].data`,
 * keeping that state out of the card file stops being free and the choice has to
 * be argued again on different ground.
 *
 * It is pinned by **key names**, not by a count. A count answers "how much is
 * there", and the question is "what kind of thing is it" — a card that replaced
 * its build stamp with a save file would keep the count and break the claim.
 */

/**
 * Every key the corpus's script data actually holds, and what each one is.
 *
 * All eight are the author's or the user's settings. None grows with play, which
 * is the whole claim: `是否显示变量更新错误` is a display toggle, `构建信息` is a
 * build stamp written by the author's pipeline, `强制重载*` and `isEnabled` are
 * feature switches, and `statusRule` is a note saying the rule moved into the
 * script body.
 */
const KNOWN_KEYS = new Set([
  '是否显示变量更新错误',
  '构建信息',
  '强制重载消息数',
  '强制重载功能',
  'statusRule',
  'isEnabled',
])

test('no card on this machine accumulates runtime state in its script data', {
  skip: !existsSync(CHARACTERS) && `no characters folder at ${CHARACTERS}; point IRIS_CORPUS at a SillyTavern install`,
}, async () => {
  let scripts = 0
  const found: string[] = []
  const unknown: string[] = []

  for (const file of (await readdir(CHARACTERS)).filter(name => name.endsWith('.png'))) {
    let card: CharacterCard
    try {
      card = normalizeCard(decodeCardPng(await readFile(join(CHARACTERS, file))))
    } catch {
      continue
    }
    // Through `extractScripts`, not a hand-rolled walk. The corpus stores these
    // under three container shapes — `tavern_helper.scripts`, `tavern_helper` as
    // an entries array, and `TavernHelper_scripts` — and a walk written from one
    // of them silently reports zero for the cards using the others. Measuring
    // this by hand got the number wrong twice in a row, once high and once low,
    // before it was measured through the reader that already knows the shapes.
    for (const script of extractScripts(card).scripts) {
      scripts += 1
      const data = script.data
      if (typeof data !== 'object' || data === null || Object.keys(data).length === 0) continue
      found.push(`${file}: ${JSON.stringify(data).slice(0, 120)}`)
      for (const key of Object.keys(data)) {
        if (!KNOWN_KEYS.has(key)) unknown.push(`${file}: ${key} = ${JSON.stringify((data as Record<string, unknown>)[key]).slice(0, 80)}`)
      }
    }
  }

  assert.ok(scripts > 40, `expected the corpus's scripts, saw ${String(scripts)}`)
  assert.ok(found.length > 0, 'no script data at all — the reader is probably not reading these cards')
  assert.deepEqual(
    unknown,
    [],
    [
      'a card stores something in its script data that was not there when the deviation was decided.',
      'Look at it before extending KNOWN_KEYS: if it grows with play, the deviation is no longer free.',
      ...unknown,
    ].join(' | '),
  )
})

test('a corrupt store is not silently the same as a first run', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'iris-script-vars-'))
  t.after(async () => { await rm(dir, { recursive: true, force: true }) })
  const path = join(dir, 'script-variables.json')
  const { writeFile } = await import('node:fs/promises')

  // Absent and unparseable share one recovery — start empty — and they are not
  // the same event. A first run is routine; a file that exists and cannot be
  // read is a card's accumulated state about to be replaced by nothing, and the
  // next save used to overwrite it. Merging them into one silent branch means
  // the user is never told which happened.
  //
  // **The tail of that sentence changed on 2026-09-11 and the test says so.**
  // The report now arrives on `onProblem` (the third argument, shared by every
  // store in this package) rather than on `onError`, and it no longer ends in
  // "saving will overwrite the file" — because saving no longer does. The bytes
  // are renamed to `<path>.corrupt-<stamp>` first, which is the fact worth
  // asserting and the reason the old wording would now be a lie.
  const quiet: string[] = []
  const fresh = new ScriptVariableStore(path, () => {}, message => { quiet.push(message) })
  assert.deepEqual(await fresh.open('aria', undefined), {})
  assert.deepEqual(quiet, [], 'a first run was reported as a problem')

  await writeFile(path, '{ this is not json', 'utf8')
  const corrupt: string[] = []
  const store = new ScriptVariableStore(path, () => {}, message => { corrupt.push(message) })
  assert.deepEqual(await store.open('aria', undefined), {})
  assert.equal(corrupt.length, 1, 'a corrupt store started over without a word')
  assert.match(corrupt[0] ?? '', /could not be read as JSON/u)
  assert.match(corrupt[0] ?? '', /it was kept as /u)

  // And the bytes are actually there, under a name the store will never write.
  const kept = (await readdir(dir)).filter(name => name.includes('.corrupt-'))
  assert.equal(kept.length, 1, 'the unparsable file was not set aside')
  assert.equal(await readFile(join(dir, kept[0] ?? ''), 'utf8'), '{ this is not json')
})

/**
 * Everything the corpus can say about buttons, split by what a red means.
 *
 * The two tests below look similar and fail for opposite reasons, which is the
 * whole point of separating them. A single test asserting exact counts is
 * ambiguous when it goes red: the parser may have regressed, or the user may
 * simply have added a card — and a reader with one message in front of them goes
 * to the parser first, because that is the failure a test usually means.
 *
 * So: **shape is a contract**, true of any library, and a red there is a real
 * regression. **Counts are a snapshot**, true of this library on this date, and
 * a red there means look at the cards before looking at the code.
 */

test('a button block has the shape upstream defines, whatever cards are present', {
  skip: !existsSync(CHARACTERS) && `no characters folder at ${CHARACTERS}; point IRIS_CORPUS at a SillyTavern install`,
}, async () => {
  // No counts here on purpose. Transcribed from
  // `JS-Slash-Runner/src/type/scripts.ts:4-33`: the wrapper is exactly
  // `{ enabled, buttons }` and a button is exactly `{ name, visible }`. This
  // holds for any card library, so a failure is the parser or a genuine change
  // in what cards contain — never "the user imported something".
  let wrappers = 0
  let buttons = 0

  for (const file of (await readdir(CHARACTERS)).filter(name => name.endsWith('.png'))) {
    let card: CharacterCard
    try {
      card = normalizeCard(decodeCardPng(await readFile(join(CHARACTERS, file))))
    } catch {
      continue
    }
    for (const script of extractScripts(card).scripts) {
      const raw = script.button
      if (raw === undefined || raw === null || typeof raw !== 'object') continue
      wrappers += 1
      assert.deepEqual(
        Object.keys(raw as object).sort(),
        ['buttons', 'enabled'],
        `${file}: a button wrapper carries keys upstream does not define`,
      )
      for (const button of (raw as { buttons?: unknown[] }).buttons ?? []) {
        buttons += 1
        assert.deepEqual(
          Object.keys(button as object).sort(),
          ['name', 'visible'],
          `${file}: a button carries keys upstream does not define`,
        )
      }
    }
  }
  assert.ok(wrappers > 0 && buttons > 0, 'no buttons were examined; the walk is not reaching them')
})

test('the button census still matches the library it was taken from', {
  skip: !existsSync(CHARACTERS) && `no characters folder at ${CHARACTERS}; point IRIS_CORPUS at a SillyTavern install`,
}, async () => {
  // A snapshot of **this** library, measured 2026-09-01 by two of us on
  // independent paths — one walking the cards, one through `extractScripts` —
  // agreeing entry for entry. The agreement is what makes it worth pinning: the
  // oracle is somebody else's measurement rather than this author's expectation.
  //
  // **If this goes red, look at the card library before the parser.** These
  // numbers are a fact about 19 particular cards; importing, updating or
  // deleting one is supposed to move them, and that is not a regression. The
  // shape test above is the one that cannot be moved by a new card.
  //
  // The message below names the tool, because telling a reader what to check
  // without telling them what to check it with leaves them where they started —
  // and the thing that answers it used to exist only in one session's scratchpad.
  let scripts = 0
  let withButtons = 0
  let buttons = 0
  let invisible = 0
  let groupsOff = 0

  for (const file of (await readdir(CHARACTERS)).filter(name => name.endsWith('.png'))) {
    let card: CharacterCard
    try {
      card = normalizeCard(decodeCardPng(await readFile(join(CHARACTERS, file))))
    } catch {
      continue
    }
    for (const script of extractScripts(card).scripts) {
      scripts += 1
      if (script.buttonsEnabled === false) groupsOff += 1
      if (script.buttons === undefined || script.buttons.length === 0) continue
      withButtons += 1
      buttons += script.buttons.length
      for (const button of script.buttons) if (!button.visible) invisible += 1
    }
  }

  assert.deepEqual(
    { scripts, withButtons, buttons, invisible, groupsOff },
    { scripts: 47, withButtons: 18, buttons: 89, invisible: 58, groupsOff: 1 },
    'the census no longer matches. Check whether the card library changed before suspecting the parser'
    + ' — these are measured values from 2026-09-01, not invariants.'
    + ' Run `npm run census:card-scripts` to see which group moved: it prints these numbers, the context'
    + ' for reading a change in them, and the shape invariants, separately.',
  )
  // Stated so whoever builds the panel cannot miss it: most buttons in this
  // corpus are hidden by their own author.
  assert.ok(invisible > buttons / 2, 'hidden is no longer the common case; a panel default may need revisiting')
})
