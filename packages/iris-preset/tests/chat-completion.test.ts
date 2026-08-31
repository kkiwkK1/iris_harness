import assert from 'node:assert/strict'
import { test } from 'node:test'

import { assemble } from '@iris/pipeline'

import {
  GLOBAL_ORDER_ID,
  GROUP_ORDER_ID,
  resolveOrder,
  resolvePreset,
  type ChatCompletionPreset,
} from '../src/index.ts'

/** A preset shaped the way SillyTavern writes one. */
function preset(): ChatCompletionPreset {
  return {
    prompts: [
      { identifier: 'main', name: 'Main Prompt', role: 'system', content: "Write {{char}}'s next reply." },
      { identifier: 'worldInfoBefore', name: 'World Info (before)', marker: true },
      { identifier: 'charDescription', name: 'Char Description', marker: true },
      { identifier: 'charPersonality', name: 'Char Personality', marker: true },
      { identifier: 'chatHistory', name: 'Chat History', marker: true },
      { identifier: 'jailbreak', name: 'Post-History Instructions', role: 'system', content: 'Stay in character.' },
    ],
    prompt_order: [
      {
        character_id: GLOBAL_ORDER_ID,
        order: [
          { identifier: 'main', enabled: true },
          { identifier: 'worldInfoBefore', enabled: true },
          { identifier: 'charDescription', enabled: true },
          { identifier: 'charPersonality', enabled: false },
          { identifier: 'chatHistory', enabled: true },
          { identifier: 'jailbreak', enabled: true },
        ],
      },
    ],
  }
}

const MARKERS = {
  worldInfoBefore: 'The city floods at dusk.',
  charDescription: 'Aria is a retired cartographer.',
  charPersonality: 'Wry.',
}

test('the global sentinel supplies the ordering when the character has none', () => {
  const order = resolveOrder(preset(), { characterId: 42 })

  assert.deepEqual(order, ['main', 'worldInfoBefore', 'charDescription', 'chatHistory', 'jailbreak'])
})

test("a character's own ordering wins over the sentinel", () => {
  const file = preset()
  file.prompt_order?.push({
    character_id: 42,
    order: [{ identifier: 'charDescription', enabled: true }, { identifier: 'main', enabled: true }],
  })

  assert.deepEqual(resolveOrder(file, { characterId: 42 }), ['charDescription', 'main'])
})

test('a group chat falls back to the group sentinel', () => {
  const file = preset()
  file.prompt_order?.push({
    character_id: GROUP_ORDER_ID,
    order: [{ identifier: 'main', enabled: true }],
  })

  assert.deepEqual(resolveOrder(file, { group: true }), ['main'])
})

test('a preset with no prompt_order falls back to file order', () => {
  const file = preset()
  delete file.prompt_order

  assert.equal(resolveOrder(file)[0], 'main')
})

test('disabled items are dropped', () => {
  const contributions = resolvePreset(preset(), { markers: MARKERS })

  assert.equal(contributions.some(item => item.id === 'charPersonality'), false)
})

test('markers are filled with live data', () => {
  const contributions = resolvePreset(preset(), { markers: MARKERS })
  const worldInfo = contributions.find(item => item.id === 'worldInfoBefore')

  assert.equal(worldInfo?.text, 'The city floods at dusk.')
})

test('a marker with nothing to say contributes nothing', () => {
  const contributions = resolvePreset(preset(), { markers: { charDescription: 'Aria.' } })

  assert.equal(contributions.some(item => item.id === 'worldInfoBefore'), false)
})

test('items before chatHistory build the system prompt, in list order', () => {
  const contributions = resolvePreset(preset(), { markers: MARKERS })
  const system = contributions.filter(item => item.placement.kind === 'system')

  assert.deepEqual(system.map(item => item.id), ['main', 'worldInfoBefore', 'charDescription'])
})

test('post-history instructions land after the conversation, not in the system prompt', () => {
  // The reason `jailbreak` exists at all: it has to be the last thing the model
  // reads, after the whole conversation.
  const contributions = resolvePreset(preset(), { markers: MARKERS })
  const jailbreak = contributions.find(item => item.id === 'jailbreak')

  assert.deepEqual(jailbreak?.placement, { kind: 'depth', depth: 0, role: 'system', order: 10 })

  const result = assemble({
    contributions,
    history: [{ role: 'user', text: 'Hello?' }],
    budget: { context: 1000, reserve: 0, count: text => text.length },
  })
  assert.equal(result.messages.at(-1)?.text, 'Stay in character.')
  assert.match(result.system, /^Write \{\{char\}\}'s next reply\./)
})

test('an absolute injection pins itself to its own depth', () => {
  const file = preset()
  file.prompts.push({
    identifier: 'authorNote',
    role: 'system',
    content: 'Keep the pace slow.',
    injection_position: 'absolute',
    injection_depth: 2,
  })
  file.prompt_order?.[0]?.order.push({ identifier: 'authorNote', enabled: true })

  const contributions = resolvePreset(file, { markers: MARKERS })
  const note = contributions.find(item => item.id === 'authorNote')

  assert.equal(note?.placement.kind, 'depth')
  assert.equal((note?.placement as { depth: number }).depth, 2)
})
