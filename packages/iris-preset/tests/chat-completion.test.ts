import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'

import { assemble } from '@iris/pipeline'

import {
  GLOBAL_ORDER_ID,
  LEGACY_ORDER_ID,
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

test('the sentinel the Chat Completion path uses wins over the class default', () => {
  // 100000 is `PromptManager`'s class default; `openai.js` overrides it to
  // 100001 for this path. A preset that carries both puts a vestigial ~10-prompt
  // list in the first and the real one in the second, so reading them the wrong
  // way round builds a prompt that is quietly far too short.
  assert.equal(GLOBAL_ORDER_ID, 100001)
  assert.equal(LEGACY_ORDER_ID, 100000)

  const file = preset()
  file.prompt_order?.push({
    character_id: LEGACY_ORDER_ID,
    order: [{ identifier: 'jailbreak', enabled: true }],
  })

  assert.deepEqual(
    resolveOrder(file),
    ['main', 'worldInfoBefore', 'charDescription', 'chatHistory', 'jailbreak'],
    'the 100001 group, not the 100000 one',
  )
})

test('a preset carrying only the class default is still read', () => {
  const file = preset()
  const order = file.prompt_order?.[0]
  if (order !== undefined) order.character_id = LEGACY_ORDER_ID

  // Better read than ignored: falling through to file order here would return
  // every prompt, including the ones the author switched off.
  assert.deepEqual(resolveOrder(file), ['main', 'worldInfoBefore', 'charDescription', 'chatHistory', 'jailbreak'])
})

test('a preset shaped like a real one yields only its enabled prompts', () => {
  // The shape that exposed the bug: 41 prompts, one `prompt_order` group under
  // 100001 listing 37 of them, 22 enabled. Under the old sentinel this matched
  // nothing and fell through to file order — 41 prompts, wrong sequence, and
  // the 15 the author had switched off included.
  const identifiers = Array.from({ length: 41 }, (_, index) => `p${String(index)}`)
  const listed = identifiers.slice(0, 37)
  const file: ChatCompletionPreset = {
    prompts: identifiers.map(identifier => ({ identifier, role: 'system', content: identifier })),
    prompt_order: [{
      character_id: 100001,
      order: listed.map((identifier, index) => ({ identifier, enabled: index % 5 !== 0 && index < 28 })),
    }],
  }

  const order = resolveOrder(file)
  const expected = listed.filter((_identifier, index) => index % 5 !== 0 && index < 28)

  assert.equal(expected.length, 22, 'the fixture really is 22 of 37')
  assert.deepEqual(order, expected)
  assert.notEqual(order.length, identifiers.length, 'not the file-order fallback')
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

/**
 * The real presets on this machine.
 *
 * Skipped without a SillyTavern install. It earns its place because the sentinel
 * bug was invisible to every fixture in this file: the fixtures were written
 * from the same belief as the code, so they used the sentinel the code looked
 * for. Only files someone else wrote could disagree.
 */
const PRESET_DIR = `${(process.env['IRIS_CORPUS'] ?? 'E:/sillyTavern/SillyTavern')}/data/default-user/OpenAI Settings`

test('every real preset resolves to its enabled prompts, not to file order', {
  skip: !existsSync(PRESET_DIR) && `no presets folder at ${PRESET_DIR}; point IRIS_CORPUS at a SillyTavern install`,
}, async () => {
  const files = (await readdir(PRESET_DIR)).filter(name => name.endsWith('.json'))
  assert.ok(files.length > 0, 'no presets to read')

  let checked = 0
  for (const name of files) {
    let file: ChatCompletionPreset
    try {
      file = JSON.parse(await readFile(join(PRESET_DIR, name), 'utf8')) as ChatCompletionPreset
    } catch {
      continue
    }
    const groups = file.prompt_order ?? []
    if (groups.length === 0 || !Array.isArray(file.prompts)) continue
    checked += 1

    const expected = (groups.find(group => group.character_id === 100001) ?? groups[0])
      ?.order.filter(entry => entry.enabled).map(entry => entry.identifier) ?? []
    const order = resolveOrder(file)

    assert.deepEqual(order, expected, `${name} did not resolve to its enabled prompts`)
    // The failure this guards is silent in both directions: too many prompts
    // (file-order fallback, including ones the author switched off) or too few
    // (the vestigial 100000 group, which real presets fill with about ten).
    assert.notEqual(order.length, file.prompts.length, `${name} fell through to file order`)
  }

  assert.ok(checked >= 5, `only checked ${String(checked)} presets`)
})

test('an empty or absent trigger list joins every generation', () => {
  const body = preset()
  body.prompts = [
    ...body.prompts,
    { identifier: 'noTrigger', role: 'system', content: 'no list.' },
    { identifier: 'emptyTrigger', role: 'system', content: 'empty list.', injection_trigger: [] },
  ]
  // BEFORE the history marker: post-history items are the one group a continue
  // drops by position, and these tests are about the trigger lists.
  const order = body.prompt_order?.[0]?.order ?? []
  const historyAt = order.findIndex(entry => entry.identifier === 'chatHistory')
  order.splice(historyAt, 0, { identifier: 'noTrigger', enabled: true }, { identifier: 'emptyTrigger', enabled: true })

  for (const generationType of ['normal', 'continue', 'impersonate']) {
    const ids = resolvePreset(body, { markers: MARKERS, generationType }).map(entry => entry.id)
    assert.ok(ids.includes('noTrigger'), `absent list dropped for ${generationType}`)
    assert.ok(ids.includes('emptyTrigger'), `empty list dropped for ${generationType}`)
  }
})

test('a populated trigger list joins only the generation types it names', () => {
  const body = preset()
  body.prompts = [
    ...body.prompts,
    { identifier: 'onlyImpersonate', role: 'system', content: 'impersonation only.', injection_trigger: ['impersonate'] },
    { identifier: 'caseOdd', role: 'system', content: 'case-insensitive.', injection_trigger: ['Continue'] },
  ]
  const order = body.prompt_order?.[0]?.order ?? []
  const historyAt = order.findIndex(entry => entry.identifier === 'chatHistory')
  order.splice(historyAt, 0, { identifier: 'onlyImpersonate', enabled: true }, { identifier: 'caseOdd', enabled: true })

  const normal = resolvePreset(body, { markers: MARKERS }).map(entry => entry.id)
  assert.ok(normal.includes('onlyImpersonate') === false, 'an impersonate-only prompt joined a normal send')
  assert.ok(normal.includes('caseOdd') === false, 'a continue-only prompt joined a normal send')

  const impersonate = resolvePreset(body, { markers: MARKERS, generationType: 'impersonate' }).map(entry => entry.id)
  assert.ok(impersonate.includes('onlyImpersonate'), 'the trigger did not fire for its own type')

  const carry = resolvePreset(body, { markers: MARKERS, generationType: 'continue' }).map(entry => entry.id)
  assert.ok(carry.includes('caseOdd'), 'the trigger match is case-insensitive, as upstream normalises the type')
})

test('a continue drops the post-history section entirely', () => {
  // Upstream keeps post-history instructions on a continue and splices the
  // continued message past them; here the section is the thing the request
  // must NOT close with — wrap-up instruction is exactly wrong when the model
  // is asked to write on. The plan (B2) rules the divergence, this test pins it.
  const normal = resolvePreset(preset(), { markers: MARKERS })
  const carry = resolvePreset(preset(), { markers: MARKERS, generationType: 'continue' })

  assert.ok(normal.some(entry => entry.id === 'jailbreak'), 'the pre-condition went missing')
  assert.ok(carry.some(entry => entry.id === 'jailbreak') === false, 'the post-history section survived a continue')
  assert.ok(carry.some(entry => entry.id === 'main'), 'the continue kept the pre-history section')
})

test('an impersonate keeps the post-history section', () => {
  const voices = resolvePreset(preset(), { markers: MARKERS, generationType: 'impersonate' })
  assert.ok(voices.some(entry => entry.id === 'jailbreak'), 'impersonation lost the post-history section')
})
