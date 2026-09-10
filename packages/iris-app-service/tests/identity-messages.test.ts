/**
 * The host half of Tavern Helper's identity and message family.
 *
 * Four arms and three snapshot fields, and what is defended here is not that
 * they answer — it is *which* things they answer about and whether a floor
 * survives being moved.
 *
 * - **Scope.** `script.getCharacter`, `script.chatHistoryBrief` and
 *   `script.chatHistoryDetail` all narrow to the open conversation's own
 *   character. Upstream narrows to nothing: it takes any name in the library
 *   and hands over the whole card, script bodies included. The narrowing is
 *   enforced *here*, on the host, because the frame is the untrusted side — so
 *   a test that only drove the frame would be checking the wrong layer.
 * - **Wholeness.** `script.rotateChatMessages` exists as a host arm rather than
 *   a frame composition precisely because `script.setChatMessages` carries a
 *   floor's text and nothing else. The rotation tests therefore assert on the
 *   **chat file**, per-floor variable tables included: a rotation that moved
 *   the words and left the tables would pass any assertion made on `mes` alone,
 *   and that is the failure mode the arm was created to avoid.
 *
 * @module @iris/app-service/tests/identity-messages
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

import type { StreamFn } from '@iris/turn'

import { BackupStore } from '../src/backups.ts'
import { ChatStore } from '../src/chats.ts'
import { CharacterLibrary } from '../src/library.ts'
import { PersonaStore } from '../src/persona.ts'
import { ScriptPolicyStore } from '../src/scripts.ts'
import { IrisAppService, type Handlers } from '../src/service.ts'
import { SettingsStore } from '../src/settings.ts'

/**
 * A description longer than the 200 code points `CharacterSummary` clips at.
 *
 * The clip is why `getCharData` omits the field and `getCharacter` carries it,
 * so the fixture has to be long enough for the two answers to differ — a short
 * description would make both look right.
 */
const LONG_DESCRIPTION = `Aria, ${'描述'.repeat(150)} end-marker`

const ARIA = JSON.stringify({
  spec: 'chara_card_v2',
  spec_version: '2.0',
  data: {
    name: 'Aria',
    description: LONG_DESCRIPTION,
    personality: '',
    scenario: '',
    first_mes: 'M0',
    mes_example: '',
    creator_notes: 'the note',
    system_prompt: '',
    post_history_instructions: '',
    alternate_greetings: ['G1', 'G2'],
    tags: ['tagged'],
    creator: 'kk',
    character_version: '3.1',
    extensions: {
      // Dropped by upstream's projection, one from each reason it drops them.
      world: 'AriaBook',
      fav: true,
      talkativeness: 0.5,
      TavernHelper_scripts: ['legacy'],
      // Kept, in the card's own stored spelling.
      regex_scripts: [{
        id: 'r1',
        scriptName: 'S',
        findRegex: '/x/',
        replaceString: 'y',
        trimStrings: [],
        placement: [1],
        disabled: false,
        markdownOnly: true,
        promptOnly: false,
        runOnEdit: false,
        substituteRegex: 0,
        minDepth: null,
        maxDepth: null,
      }],
      // The legacy pair-array shape upstream repairs on the way out.
      tavern_helper: [['scripts', [{ name: 'panel', content: 'void 0', info: 'by kk' }]]],
      // Not on upstream's omit list, so it survives.
      keptByBoth: 1,
    },
  },
})

const BELLA = JSON.stringify({
  spec: 'chara_card_v2',
  spec_version: '2.0',
  data: {
    name: 'Bella',
    description: 'the neighbour',
    personality: '',
    scenario: '',
    first_mes: 'B0',
    mes_example: '',
    creator_notes: '',
    system_prompt: '',
    post_history_instructions: '',
    alternate_greetings: [],
    tags: [],
    creator: '',
    character_version: '1',
    extensions: {},
  },
})

interface Fixture {
  handlers: Handlers
  dir: string
  /** Aria's conversation, the open one. */
  chatId: string
  /** Aria's second conversation, which the open one may read. */
  otherChatId: string
  /** Bella's conversation, which it may not. */
  bellaChatId: string
  /**
   * The floors of Aria's open conversation on **disk**, as `mes` plus its table.
   *
   * Saved first, and deliberately: a card write arm here does not write the
   * file — `script.saveChat` is the one decision, and this house rule is what
   * `chat-writes.test.ts` pins — so a file read without it would be reading the
   * state before the call under test.
   */
  floors: () => Promise<{ mes: string, table: unknown }[]>
  /**
   * The same floors out of the **live** log, without touching the disk.
   *
   * The counterpart to {@link floors} and not a duplicate of it: `rebuild`
   * carries tables across by position, and the failure this project has already
   * had is a table that reached the file and not the live log — the same read
   * answering differently before and after a restart. `chat.export` serialises
   * the open entry's own projection, so the pair covers both sides of that.
   *
   * Deliberately **not** `script.context`'s `floor.variables`: that read is
   * per-**turn** (`lineTurns` maps a line to its turn and then to the selected
   * candidate), so a user line and the reply beside it report one table and a
   * user line with no reply yet reports none. Measured on this fixture before
   * any rotation: the file holds A, B, C on floors 1-3 while that read answers
   * -, B, B, - . Correct for the question it answers, and the wrong unit for
   * this one.
   */
  liveFloors: () => Promise<{ mes: string, table: unknown }[]>
  /**
   * Play `count` real turns, each leaving a message-scope table behind.
   *
   * A turn is two lines (the user's and the reply's) and **one candidate**, and
   * the candidate is what `rebuild`'s index mapping carries. Floors created by
   * `script.createChatMessages` are not enough for that: their tables ride on
   * the line itself, through `iris/st-meta`, so they travel whenever the line
   * does — which made a rotation that spliced the lines and dropped the mapping
   * pass. That mutation is what this fixture exists to make red.
   */
  turns: (count: number) => Promise<void>
  /** Each floor's candidate table marker, from the live log. */
  candidateTables: () => Promise<(string | undefined)[]>
  /** How many pre-change snapshots this conversation has accumulated. */
  snapshots: () => Promise<number>
}

/**
 * A profile with two cards, three conversations, and personas.
 * @param t - the test context, for cleanup.
 * @param withPersonas - whether the host has a persona store at all.
 * @returns the fixture.
 */
async function fixture(t: TestContext, withPersonas = true): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), 'iris-identity-'))
  t.after(async () => { await rm(dir, { recursive: true, force: true }) })
  await mkdir(join(dir, 'characters'), { recursive: true })
  await writeFile(join(dir, 'characters', 'aria.json'), ARIA, 'utf8')
  await writeFile(join(dir, 'characters', 'bella.json'), BELLA, 'utf8')

  const library = new CharacterLibrary(join(dir, 'characters'), '/iris/avatar')
  const chats = new ChatStore(join(dir, 'chats'), library)
  const stream: StreamFn = async function* () {
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  const personas = new PersonaStore(join(dir, 'personas.json'))
  let ends = 0
  const handlers = new IrisAppService({
    stream,
    library,
    chats,
    settings: new SettingsStore(join(dir, 'settings.json'), { provider: 'test', model: 'test-model' }),
    broadcast: event => { if (event.type === 'stream.end') ends += 1 },
    userName: 'U',
    // A snapshot store, because one of the rotation's two observable effects is
    // that it *takes* a pre-change copy — and that a collapsed span does not.
    // Without the store both branches write nothing and look identical.
    backups: new BackupStore(join(dir, 'chats'), { keep: 50 }),
    // `script.context`'s `scripts` field comes out of `listAllScripts`, which
    // answers nothing at all without this store — so a test asserting on a
    // script name would have been comparing two absences.
    scripts: new ScriptPolicyStore(join(dir, 'script-policy.json')),
    ...withPersonas ? { personas } : {},
  }).handlers()

  if (withPersonas) {
    await handlers['persona.set']({ name: 'Traveller', description: 'a wanderer', position: 'atdepth', depth: 7, role: 'user', active: true })
    await handlers['persona.set']({ name: 'Shadow', description: 'the other one' })
  }

  const aria = await handlers['chat.create']({ characterId: 'aria' })
  const other = await handlers['chat.create']({ characterId: 'aria' })
  const bella = await handlers['chat.create']({ characterId: 'bella' })
  const chatId = aria.view.chatId

  return {
    handlers,
    dir,
    chatId,
    otherChatId: other.view.chatId,
    bellaChatId: bella.view.chatId,
    floors: async () => {
      await handlers['script.saveChat']({ chatId })
      const text = await readFile(join(dir, 'chats', `${chatId}.jsonl`), 'utf8')
      return text
        .split('\n')
        .filter(line => line.trim().length > 0)
        .slice(1)
        .map(line => JSON.parse(line) as { mes: string, variables?: unknown })
        .map(line => ({ mes: line.mes, table: line.variables }))
    },
    liveFloors: async () => {
      const { content } = await handlers['chat.export']({ chatId })
      return content
        .split('\n')
        .filter(line => line.trim().length > 0)
        .slice(1)
        .map(line => JSON.parse(line) as { mes: string, variables?: unknown })
        .map(line => ({ mes: line.mes, table: line.variables }))
    },
    turns: async (count: number) => {
      for (let turn = 0; turn < count; turn += 1) {
        await handlers['chat.send']({ chatId, text: `U${String(turn)}` })
        while (ends < turn + 1) await new Promise(resolve => setTimeout(resolve, 1))
        // The turn's own message-scope table, written the way a card writes
        // one. This is the state `rebuild`'s index mapping carries: it lives in
        // the event log against the candidate, not on the line, so a rotation
        // that spliced the lines and not the mapping would leave it behind.
        await handlers['script.setVariables']({
          chatId,
          scope: 'message',
          op: 'replace',
          variables: { turn: `T${String(turn)}` },
        })
      }
    },
    candidateTables: async () => {
      const view = (await handlers['chat.open']({ chatId })).view
      const tables: (string | undefined)[] = []
      for (let floor = 0; floor < view.messages.length; floor += 1) {
        const { context } = await handlers['script.context']({ chatId, characterId: 'aria', messageId: floor })
        tables.push((context.floor?.variables as { turn?: string } | undefined)?.turn)
      }
      return tables
    },
    snapshots: async () => (await handlers['backup.list']({ chatId })).backups.length,
  }
}

// ── script.getCharacter ──────────────────────────────────────────────────

test('getCharacter projects the card the way upstream projects it', async (t) => {
  const fixed = await fixture(t)
  const { character } = await fixed.handlers['script.getCharacter']({
    chatId: fixed.chatId,
    name: 'current',
  })

  // The fold: `first_mes` then every alternate greeting, upstream's one array.
  assert.deepEqual(character.first_messages, ['M0', 'G1', 'G2'])
  assert.equal(character.version, '3.1')
  assert.equal(character.creator, 'kk')
  assert.equal(character.creator_notes, 'the note')
  // Unclipped, which is the whole reason this member is a round trip while
  // `getCharData` reads the snapshot.
  assert.equal(character.description, LONG_DESCRIPTION)
  assert.ok(character.description.length > 200, 'the fixture must exceed the summary clip to prove anything')
  // The host's id, not upstream's `${name}.png`.
  assert.equal(character.avatar, 'aria')
  assert.equal(character.worldbook, 'AriaBook')
})

test('getCharacter drops the keys upstream drops, and keeps the rest', async (t) => {
  const fixed = await fixture(t)
  const { character } = await fixed.handlers['script.getCharacter']({
    chatId: fixed.chatId,
    name: 'current',
  })
  const extensions = character.extensions

  for (const dropped of ['world', 'fav', 'talkativeness', 'TavernHelper_scripts']) {
    assert.equal(Object.hasOwn(extensions, dropped), false, `${dropped} is on upstream's omit list`)
  }
  assert.equal(extensions['keptByBoth'], 1, 'a key upstream does not omit must survive')
  // The stored spelling, deliberately: the TavernRegex projection belongs to
  // the regex family and Iris has not built it, so inventing it here would put
  // two shapes of one fact in the product.
  const regexes = extensions['regex_scripts'] as { scriptName?: string, script_name?: string }[]
  assert.equal(regexes[0]?.scriptName, 'S')
  assert.equal(regexes[0]?.script_name, undefined)
})

test('getCharacter repairs the legacy pair-array tavern_helper, as upstream does', async (t) => {
  const fixed = await fixture(t)
  const { character } = await fixed.handlers['script.getCharacter']({
    chatId: fixed.chatId,
    name: 'current',
  })
  const helper = character.extensions['tavern_helper'] as { scripts?: { name: string }[] }
  assert.equal(Array.isArray(helper), false, 'a card reading .scripts off an array gets undefined')
  assert.equal(helper.scripts?.[0]?.name, 'panel')
})

test('getCharacter answers to the id and the name, folded, and refuses a neighbour', async (t) => {
  const fixed = await fixture(t)
  for (const name of ['current', 'aria', 'ARIA', 'Aria']) {
    const answer = await fixed.handlers['script.getCharacter']({ chatId: fixed.chatId, name })
    assert.equal(answer.character.avatar, 'aria', `"${name}" names this conversation's card`)
  }

  await assert.rejects(
    fixed.handlers['script.getCharacter']({ chatId: fixed.chatId, name: 'bella' }),
    (error: unknown) => {
      const refusal = error as { code?: string, message?: string }
      assert.equal(refusal.code, 'unsupported', 'a real card refused by scope is not "not found"')
      assert.match(String(refusal.message), /own character/)
      return true
    },
    'a neighbouring card that really exists must still be refused',
  )
})

// ── script.chatHistoryBrief ──────────────────────────────────────────────

test('chatHistoryBrief lists this character\'s conversations and no others', async (t) => {
  const fixed = await fixture(t)
  const { chats } = await fixed.handlers['script.chatHistoryBrief']({ chatId: fixed.chatId })

  const ids = chats.map(row => row.chatId).sort()
  assert.deepEqual(ids, [fixed.chatId, fixed.otherChatId].sort())
  assert.equal(
    chats.some(row => row.chatId === fixed.bellaChatId),
    false,
    'another character\'s conversation must not appear',
  )

  const open = chats.find(row => row.chatId === fixed.chatId)
  assert.equal(open?.file_name, `${fixed.chatId}.jsonl`)
  assert.equal(open?.ch_name, 'Aria')
  assert.equal(open?.avatar_url, 'aria')
  // The greeting is floor 0, so a fresh conversation holds exactly one.
  assert.equal(open?.chat_items, 1)
})

// ── script.chatHistoryDetail ─────────────────────────────────────────────

test('chatHistoryDetail reads the named files, drops the header, and strips the tables', async (t) => {
  const fixed = await fixture(t)
  await fixed.handlers['script.createChatMessages']({
    chatId: fixed.otherChatId,
    messages: [{ name: 'Aria', is_user: false, mes: 'in the other chat', variables: { kept: 1 } }],
  })
  await fixed.handlers['script.saveChat']({ chatId: fixed.otherChatId })

  const { chats } = await fixed.handlers['script.chatHistoryDetail']({
    chatId: fixed.chatId,
    files: [`${fixed.otherChatId}.jsonl`],
  })
  const floors = chats[`${fixed.otherChatId}.jsonl`]
  assert.ok(floors !== undefined, 'the requested file must be a key of the answer')
  // The header is not a floor: `M0` then the appended line, nothing before them.
  assert.deepEqual(floors.map(floor => floor.mes), ['M0', 'in the other chat'])
  assert.equal(
    floors.every(floor => floor['variables'] === undefined),
    true,
    'another conversation\'s per-floor tables do not travel',
  )
})

test('chatHistoryDetail answers nothing for a file that is not this character\'s', async (t) => {
  const fixed = await fixture(t)
  const { chats } = await fixed.handlers['script.chatHistoryDetail']({
    chatId: fixed.chatId,
    files: [`${fixed.bellaChatId}.jsonl`, 'no-such-chat.jsonl', `${fixed.chatId}.jsonl`],
  })
  // Absent keys, not empty arrays: an unreadable conversation and an empty one
  // are different answers, and upstream's own reader never writes the key.
  assert.deepEqual(Object.keys(chats), [`${fixed.chatId}.jsonl`])
})

test('chatHistoryDetail takes a file name with or without its extension', async (t) => {
  const fixed = await fixture(t)
  const { chats } = await fixed.handlers['script.chatHistoryDetail']({
    chatId: fixed.chatId,
    files: [fixed.chatId],
  })
  assert.deepEqual(Object.keys(chats), [fixed.chatId], 'the key is what the card asked with')
})

// ── script.rotateChatMessages ────────────────────────────────────────────

/**
 * Append three floors carrying distinguishable per-floor tables.
 * @param fixed - the fixture.
 */
async function seedFloors(fixed: Fixture): Promise<void> {
  await fixed.handlers['script.createChatMessages']({
    chatId: fixed.chatId,
    messages: [
      { name: 'U', is_user: true, mes: 'A', variables: { at: 'A' } },
      { name: 'Aria', is_user: false, mes: 'B', variables: { at: 'B' } },
      { name: 'U', is_user: true, mes: 'C', variables: { at: 'C' } },
    ],
  })
}

test('a rotation moves floors whole, with their own variable tables', async (t) => {
  const fixed = await fixture(t)
  await seedFloors(fixed)
  const before = await fixed.floors()
  assert.deepEqual(before.map(floor => floor.mes), ['M0', 'A', 'B', 'C'])

  // Upstream's own example: put the last floor before floor 1.
  await fixed.handlers['script.rotateChatMessages']({
    chatId: fixed.chatId,
    begin: 1,
    middle: 3,
    end: 4,
  })

  const after = await fixed.floors()
  assert.deepEqual(after.map(floor => floor.mes), ['M0', 'C', 'A', 'B'])
  // **The property the arm exists for.** A rotation composed out of
  // `script.setChatMessages` would produce exactly the line above and leave
  // every table where it was, so the text order alone cannot tell the two
  // apart. Each floor's table must have travelled with its text.
  assert.deepEqual(
    after.map(floor => [floor.mes, (floor.table as { at?: string }[] | undefined)?.[0]?.at]),
    [['M0', undefined], ['C', 'C'], ['A', 'A'], ['B', 'B']],
  )
  // And in the live log, not only in the file: the index mapping is what
  // carries them, and a mapping that reached one and not the other is the
  // failure `rebuild-hydration.test.ts` was written for.
  assert.deepEqual(
    (await fixed.liveFloors()).map(floor => [floor.mes, (floor.table as { at?: string }[] | undefined)?.[0]?.at]),
    [['M0', undefined], ['C', 'C'], ['A', 'A'], ['B', 'B']],
  )
})

test('a rotation carries each turn\'s candidate table, not only its text', async (t) => {
  const fixed = await fixture(t)
  await fixed.turns(3)
  // Floors: 0 the greeting, then (1,2) (3,4) (5,6) — three turns of two lines.
  assert.deepEqual(await fixed.candidateTables(), [undefined, 'T0', 'T0', 'T1', 'T1', 'T2', 'T2'])

  // The last turn's two lines to the front, upstream's own example shape.
  await fixed.handlers['script.rotateChatMessages']({
    chatId: fixed.chatId,
    begin: 1,
    middle: 5,
    end: 7,
  })

  assert.deepEqual((await fixed.floors()).map(floor => floor.mes), ['M0', 'U2', '', 'U0', '', 'U1', ''])
  // **The mapping, not the splice.** Every line moved either way; what only a
  // spliced index mapping does is bring the candidate — and its table — with
  // it. An identity mapping produces the line order above and leaves these
  // three markers where they were.
  assert.deepEqual(await fixed.candidateTables(), [undefined, 'T2', 'T2', 'T0', 'T0', 'T1', 'T1'])
})

test('a span that collapses is upstream\'s no-op, and costs no snapshot', async (t) => {
  const fixed = await fixture(t)
  await seedFloors(fixed)
  const before = await fixed.floors()
  assert.equal(await fixed.snapshots(), 0)

  // `middle` clamps into `[begin, end]`, so both of these collapse.
  await fixed.handlers['script.rotateChatMessages']({ chatId: fixed.chatId, begin: 1, middle: 1, end: 3 })
  await fixed.handlers['script.rotateChatMessages']({ chatId: fixed.chatId, begin: 1, middle: 9, end: 3 })

  assert.deepEqual(await fixed.floors(), before)
  // The floors alone cannot tell a no-op from a rotation of nothing: both leave
  // the same file. The observable difference is the retention window — a card
  // rotating an empty span every turn must not churn it — so that is what is
  // asserted.
  assert.equal(await fixed.snapshots(), 0, 'a collapsed span took a pre-change copy')

  await fixed.handlers['script.rotateChatMessages']({ chatId: fixed.chatId, begin: 1, middle: 3, end: 4 })
  assert.equal(await fixed.snapshots(), 1, 'a real rotation must be recoverable')
})

test('negative indices count from the end, as upstream\'s clamp allows', async (t) => {
  const fixed = await fixture(t)
  await seedFloors(fixed)

  // The last floor to the front: begin 0, middle -1, end 4.
  await fixed.handlers['script.rotateChatMessages']({ chatId: fixed.chatId, begin: 0, middle: -1, end: 4 })
  assert.deepEqual((await fixed.floors()).map(floor => floor.mes), ['C', 'M0', 'A', 'B'])
})

// ── the three snapshot fields ────────────────────────────────────────────

test('the snapshot carries every persona by name and the selected one in full', async (t) => {
  const fixed = await fixture(t)
  const { context } = await fixed.handlers['script.context']({
    chatId: fixed.chatId,
    characterId: 'aria',
  })

  assert.deepEqual(context.personas?.map(row => row.name).sort(), ['Shadow', 'Traveller'])
  // Names and ids only for the list: no description rides along.
  assert.deepEqual(
    context.personas?.every(row => Object.keys(row).sort().join(',') === 'id,name'),
    true,
  )
  assert.equal(context.persona?.name, 'Traveller')
  assert.equal(context.persona?.description, 'a wanderer')
  assert.equal(context.persona?.position, 'atdepth')
  assert.equal(context.persona?.depth, 7)
  assert.equal(context.persona?.role, 'user')
})

test('a host with no persona store omits the key rather than sending an empty list', async (t) => {
  const fixed = await fixture(t, false)
  const { context } = await fixed.handlers['script.context']({
    chatId: fixed.chatId,
    characterId: 'aria',
  })
  // Key-missing and empty are different facts, and the frame reports the first
  // as a gap: a default here would erase the distinction before it could.
  assert.equal(Object.hasOwn(context, 'personas'), false)
  assert.equal(context.persona, undefined)
})

test('the snapshot carries each script\'s name and author note, by id', async (t) => {
  const fixed = await fixture(t)
  const { context } = await fixed.handlers['script.context']({
    chatId: fixed.chatId,
    characterId: 'aria',
  })

  const rows = Object.values(context.scripts ?? {})
  assert.deepEqual(rows.map(row => row.name), ['panel'])
  assert.deepEqual(rows.map(row => row.info), ['by kk'])
  // Keyed by the same script id `script.list` uses, which is what the frame's
  // `getScriptId()` answers with — the two have to agree or `getScriptName()`
  // reads nothing.
  const { scripts } = await fixed.handlers['script.list']({ characterId: 'aria' })
  assert.deepEqual(Object.keys(context.scripts ?? {}), scripts.map(row => row.id))
})
