import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import type { CharacterCard } from '@iris/character'
import type { LorebookEntry } from '@iris/lorebook'

import { buildPrompt, DEFAULT_PRESET } from '../src/prompt.ts'
import { PersonaStore } from '../src/persona.ts'

/**
 * Personas: the store's file semantics and the assembler's three positions.
 *
 * The red line the suite pins: **no persona, no change.** Every test with a
 * persona has a sibling without one, and the no-persona answers are exactly
 * what the assembler produced before a store existed.
 */

/** A minimal card, with whatever the test needs layered on. */
function card(data: Partial<CharacterCard['data']> = {}): CharacterCard {
  return {
    spec: 'chara_card_v3',
    spec_version: '3.0',
    data: {
      name: 'Aria',
      description: 'A retired cartographer.',
      personality: '',
      scenario: '',
      first_mes: 'Hello.',
      mes_example: '',
      creator_notes: '',
      system_prompt: '',
      post_history_instructions: '',
      alternate_greetings: [],
      tags: [],
      creator: '',
      character_version: '1',
      extensions: {},
      ...data,
    },
  }
}

/** A full LorebookEntry, upstream's shipped defaults, with overrides. */
function loreEntry(uid: number, overrides: Partial<LorebookEntry>): LorebookEntry {
  return {
    uid,
    key: [],
    keysecondary: [],
    comment: '',
    content: '',
    constant: false,
    vectorized: false,
    selective: false,
    selectiveLogic: 0,
    order: 100,
    position: 0,
    disable: false,
    excludeRecursion: false,
    preventRecursion: false,
    delayUntilRecursion: false,
    probability: 100,
    useProbability: false,
    depth: 4,
    group: '',
    groupOverride: false,
    groupWeight: 100,
    scanDepth: null,
    caseSensitive: false,
    matchWholeWords: false,
    useGroupScoring: false,
    automationId: '',
    role: 0,
    sticky: null,
    cooldown: null,
    delay: null,
    displayIndex: uid,
    characterFilter: { isExclude: false, names: [], tags: [] },
    ignoreBudget: false,
    outletName: '',
    triggers: [],
    addMemo: false,
    matchPersonaDescription: false,
    matchCharacterDescription: false,
    matchCharacterPersonality: false,
    matchCharacterDepthPrompt: false,
    matchScenario: false,
    matchCreatorNotes: false,
    ...overrides,
  }
}

/** A worldbook the assembler reads: one book, whatever entries the test lists. */
function bookOf(entries: LorebookEntry[]): {
  entries: LorebookEntry[]
  source: 'named'
  world: string
  additional: { world: string, entries: LorebookEntry[] }[]
  global: { world: string, entries: LorebookEntry[] }[]
} {
  return { entries, source: 'named', world: 'TestBook', additional: [], global: [] }
}

/** A preset whose main prompt asks for the persona explicitly. */
const PERSONA_PRESET = {
  prompts: [
    { identifier: 'main', role: 'system' as const, content: 'User is: {{persona}}' },
    { identifier: 'personaDescription', marker: true },
    { identifier: 'chatHistory', marker: true },
  ],
}

function assemble(persona?: { description: string, position: 'inprompt' | 'atdepth' | 'none', depth: number, role: 'system' | 'user' | 'assistant' }) {
  return buildPrompt({
    card: card(),
    preset: PERSONA_PRESET,
    userName: 'Traveller',
    characterName: 'Aria',
    history: [{ role: 'user', text: 'Hello?' }],
    count: text => text.length,
    worldInfoBudget: 1000,
    ...persona === undefined ? {} : { persona },
  })
}

// --------------------------------------------------------------------- store

test('a persona is created, activated and edited in place', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'iris-persona-'))
  const store = new PersonaStore(join(dir, 'personas.json'))

  const created = await store.upsert({ name: 'Wanderer', description: 'A hooded traveller.', active: true })
  assert.equal(created.personas.length, 1)
  assert.equal(created.activeId, created.personas[0]?.id)

  // Activation is explicit: an edit without `active` does not steal it.
  const id = created.personas[0]?.id ?? ''
  const edited = await store.upsert({ id, name: 'Wanderer', description: 'A hooded traveller with a map.' })
  assert.equal(edited.activeId, id)
  // `get()` without an id reads the active persona.
  assert.equal((await store.get())?.description, 'A hooded traveller with a map.')
  assert.equal((await store.get(id))?.description, 'A hooded traveller with a map.')
  assert.equal((await store.active())?.description, 'A hooded traveller with a map.')
})

test('an absent description on an edit keeps what is stored', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'iris-persona-'))
  const store = new PersonaStore(join(dir, 'personas.json'))
  const { personas } = await store.upsert({ name: 'Wanderer', description: 'Kept.' })
  const keptId = personas[0]?.id ?? ''
  await store.upsert({ id: keptId, name: 'Renamed' })
  assert.equal((await store.get(keptId))?.description, 'Kept.',
    'a rename must not blank the description it was never shown')
})

test('the store persists across instances', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'iris-persona-'))
  const path = join(dir, 'personas.json')
  const first = new PersonaStore(path)
  const { personas } = await first.upsert({ name: 'Wanderer', description: 'Hooded.', active: true })

  const second = new PersonaStore(path)
  const listed = await second.list()
  assert.deepEqual(listed.personas.map(persona => persona.name), ['Wanderer'])
  assert.equal(listed.activeId, personas[0]?.id)
  const body = JSON.parse(await readFile(path, 'utf8')) as { personas: unknown[] }
  assert.equal(body.personas.length, 1)
})

test('removing the active persona clears the activation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'iris-persona-'))
  const store = new PersonaStore(join(dir, 'personas.json'))
  const first = await store.upsert({ name: 'One', active: true })
  const one = first.personas[0]?.id ?? ''
  const second = await store.upsert({ name: 'Two' })
  const two = second.personas[1]?.id ?? ''

  await store.remove(one)
  const after = await store.list()
  assert.deepEqual(after.personas.map(persona => persona.name), ['Two'])
  assert.equal(after.activeId, undefined, 'the cleared activation must not survive as a dangling id')

  // The other persona can then be activated and removed without touching it.
  await store.upsert({ id: two, name: 'Two', active: true })
  await store.remove(two)
  assert.equal((await store.list()).activeId, undefined)

  await assert.rejects(store.remove('no-such-persona'), /no persona/)
})

test('an empty description is no persona', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'iris-persona-'))
  const store = new PersonaStore(join(dir, 'personas.json'))
  await store.upsert({ name: 'Wanderer', description: '   ', active: true })

  // Upstream guards every read with `if (!power_user.persona_description …)`;
  // the same guard here is what keeps an unwritten persona a no-op everywhere.
  assert.equal(await store.active(), undefined)
})

test('a malformed persona is refused by name', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'iris-persona-'))
  const store = new PersonaStore(join(dir, 'personas.json'))
  await assert.rejects(store.upsert({ name: '   ' }), /name/)
  await assert.rejects(store.upsert({ name: 'X', depth: -1 }), /depth/)
  await assert.rejects(store.upsert({ id: 'no-such', name: 'X' }), /no persona/)
})

// ------------------------------------------------------------------ assembly

test('no persona changes nothing: the marker stays empty and {{persona}} expands to nothing', () => {
  const bare = assemble()
  const withEmpty = assemble({ description: '', position: 'inprompt', depth: 2, role: 'system' })

  for (const { contributions } of [bare, withEmpty]) {
    // Empty contributions are dropped before the join, which is what
    // `renderSystem` does with them (`@iris/pipeline`): a slot that rendered
    // nothing is offered as a zero-token row so the itemization can show it,
    // and must not put a blank paragraph in the prompt.
    const system = contributions
      .filter(item => item.placement.kind === 'system')
      .map(item => item.text)
      .filter(text => text.length > 0)
      .join('\n')
    assert.doesNotMatch(system, /hooded/)
    assert.match(system, /User is: $/, 'the {{persona}} macro expanded to the empty string it always was')
    // The `personaDescription` slot is offered and empty; what must not exist
    // is a persona-specific contribution of any kind.
    assert.equal(contributions.some(item => item.id === 'persona.depthPrompt'), false)
    assert.equal(contributions.find(item => item.id === 'personaDescription')?.text, '')
  }
})

test('IN_PROMPT fills the personaDescription slot, and the macro follows', () => {
  const { contributions } = assemble({
    description: 'A hooded cartographer with ink-stained fingers.',
    position: 'inprompt',
    depth: 2,
    role: 'system',
  })

  const system = contributions.filter(item => item.placement.kind === 'system').map(item => item.text).join('\n')
  assert.match(system, /A hooded cartographer with ink-stained fingers\./)
  assert.match(system, /User is: A hooded cartographer/, 'the {{persona}} macro carries the active description')
  assert.equal(contributions.some(item => item.id === 'persona.depthPrompt'), false,
    'the depth injection belongs to the atdepth position only')
})

test('the macro trims the description; the slot and the depth injection keep it verbatim', () => {
  // Both halves are upstream's own reads: the macro environment resolves
  // `persona_description?.trim()` (`script.js:3352`), while the slot
  // (`openai.js:1424`) and the depth injection (`script.js:3164`) take the
  // stored string as it is.
  const description = '  A hooded cartographer with ink-stained fingers.  '

  const inprompt = assemble({ description, position: 'inprompt', depth: 2, role: 'system' })
  const system = inprompt.contributions.filter(item => item.placement.kind === 'system').map(item => item.text).join('\n')
  assert.match(system, /User is: A hooded cartographer/, 'the macro expansion is trimmed')
  assert.doesNotMatch(system, /User is:   A hooded/, 'no untrimmed text reaches the macro')
  assert.ok(system.includes(description), 'the slot carries the stored text verbatim')

  const atdepth = assemble({ description, position: 'atdepth', depth: 3, role: 'user' })
  const injected = atdepth.contributions.find(item => item.id === 'persona.depthPrompt')
  assert.equal(injected?.text, description, 'the depth injection carries the stored text verbatim')
})

test('AT_DEPTH injects at the persona depth and stays out of the system sections', () => {
  const { contributions } = assemble({
    description: '[The traveller hums an old walking song.]',
    position: 'atdepth',
    depth: 3,
    role: 'user',
  })

  // The {{persona}} macro itself is position-blind — upstream resolves it
  // from the persona description unconditionally (`script.js:3353`) — so the
  // description still reaches the prompt wherever the preset says
  // {{persona}}. What AT_DEPTH decides is that the personaDescription *slot*
  // contributes nothing and the text lands as a depth injection.
  const system = contributions.filter(item => item.placement.kind === 'system').map(item => item.text).join('\n')
  assert.doesNotMatch(system, /personaDescription/, 'the marker slot stays empty at atdepth')
  assert.equal(system.split('walking song').length - 1, 1, 'only the macro expansion, not a marker, carries it')
  const injected = contributions.find(item => item.id === 'persona.depthPrompt')
  assert.deepEqual(injected?.placement, { kind: 'depth', depth: 3, role: 'user', order: 1 })
  assert.match(injected?.text ?? '', /walking song/)
})

test('NONE keeps the slot and the depth injection out of the prompt but the description in the world-info scan', () => {
  // The secondary key lives only in the persona description: the chat says the
  // primary word, and only the scan's persona half supplies the keysecondary.
  // Upstream assembles the scan haystack the same way (`world-info.js`, the
  // `matchPersonaDescription` row of the scan buffer).
  const worldbook = bookOf([
    loreEntry(0, {
      key: ['lighthouse'],
      keysecondary: ['ice'],
      selective: true,
      selectiveLogic: 0,
      content: 'The lighthouse keeper never speaks of the frozen year.',
      matchPersonaDescription: true,
    }),
  ])

  const persona = {
    description: 'A cartographer with a freeze-scar and an ice-blue ring.',
    position: 'none' as const,
    depth: 2,
    role: 'system' as const,
  }

  const { contributions, activated } = buildPrompt({
    card: card(),
    worldbook,
    preset: PERSONA_PRESET,
    userName: 'Traveller',
    characterName: 'Aria',
    history: [{ role: 'user', text: 'Tell me about the lighthouse.' }],
    count: text => text.length,
    worldInfoBudget: 1000,
    persona,
  })

  const system = contributions.filter(item => item.placement.kind === 'system').map(item => item.text).join('\n')
  assert.equal(system.split('freeze-scar').length - 1, 1,
    'only the position-blind {{persona}} macro carries it; the slot contributes nothing')
  assert.equal(contributions.some(item => item.id === 'persona.depthPrompt'), false)
  assert.deepEqual(activated.map(entry => entry.content),
    ['The lighthouse keeper never speaks of the frozen year.'],
    'the secondary key matched inside the persona description')
})

test('the persona scan half is silent without a persona, and the secondary key cannot fire on nothing', () => {
  const worldbook = bookOf([
    loreEntry(0, {
      key: ['lighthouse'],
      keysecondary: ['ice'],
      selective: true,
      selectiveLogic: 0,
      content: 'The lighthouse keeper never speaks of the frozen year.',
      matchPersonaDescription: true,
    }),
  ])

  const { activated } = buildPrompt({
    card: card(),
    worldbook,
    preset: PERSONA_PRESET,
    userName: 'Traveller',
    characterName: 'Aria',
    history: [{ role: 'user', text: 'Tell me about the lighthouse.' }],
    count: text => text.length,
    worldInfoBudget: 1000,
  })

  assert.deepEqual(activated, [], 'no persona, no persona scan half, no activation')
})
