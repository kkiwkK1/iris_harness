import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'

import type { CharacterCard } from '@iris/character'

import { applyCardOverrides, buildPrompt, DEFAULT_PRESET, scanEntriesOf } from '../src/prompt.ts'
import { fileFor, isSafeId, toId, uniqueId } from '../src/paths.ts'
import { presetScalarPatch } from '../src/service.ts'
import { sanitize } from '../src/settings.ts'

/**
 * The pure parts: identity, settings validation, and prompt policy.
 *
 * Identity gets the most attention because it is the only place in this package
 * where a browser-supplied string becomes a filesystem path.
 */

/** A minimal card, with whatever the test needs layered on. */
function card(data: Partial<CharacterCard['data']> = {}): CharacterCard {
  return {
    spec: 'chara_card_v3',
    spec_version: '3.0',
    data: {
      name: 'Aria',
      description: 'A retired cartographer.',
      personality: 'Dry, patient.',
      scenario: 'A map shop at closing time.',
      first_mes: 'Hello, {{user}}.',
      mes_example: '',
      creator_notes: 'Do not send this to the model.',
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

test('an id that would leave its directory is not an id', () => {
  const allowed = ['aria', 'Aria-2', '络络', 'chat.2026', 'a_b-c.d']
  for (const id of allowed) assert.equal(isSafeId(id), true, id)

  const refused = [
    '..',
    '.',
    '../secrets',
    'a/b',
    'a\\b',
    'a:b',
    '',
    'CON',
    'nul.jsonl',
    'x'.repeat(121),
    'chat\u0000',
  ]
  for (const id of refused) assert.equal(isSafeId(id), false, id)
})

test('a traversal attempt is refused rather than normalized away', () => {
  assert.throws(() => fileFor('/data/chats', '../settings', '.jsonl'), /not a valid identifier/)
  assert.throws(() => fileFor('/data/chats', 'a/b', '.jsonl'), /not a valid identifier/)
  assert.match(fileFor('/data/chats', 'aria', '.jsonl').replaceAll('\\', '/'), /\/data\/chats\/aria\.jsonl$/)
})

test('a name becomes an id that keeps its language', () => {
  assert.equal(toId('Aria the Cartographer.png'), 'Aria-the-Cartographer')
  assert.equal(toId('络络.json'), '络络')
  assert.equal(toId('../../etc/passwd'), 'etcpasswd')
  assert.equal(toId('...'), 'unnamed')
  assert.equal(toId(''), 'unnamed')
})

test('a claimed id gets the next free suffix', () => {
  const taken = new Set(['aria', 'aria-2'])
  assert.equal(uniqueId('aria', id => taken.has(id)), 'aria-3')
  assert.equal(uniqueId('luoluo', id => taken.has(id)), 'luoluo')
})

test('settings keep known fields and refuse malformed ones', () => {
  assert.deepEqual(
    sanitize({ provider: 'deepseek', model: 'deepseek-v4-flash', temperature: 0.8, topP: 0.92, stop: ['\nUser:'] }),
    {
      set: { provider: 'deepseek', model: 'deepseek-v4-flash', temperature: 0.8, topP: 0.92, stop: ['\nUser:'] },
      clear: [],
    },
  )
  // Integral fields are rounded rather than refused: a slider that emits 512.4
  // is a UI artefact, not a user mistake.
  assert.deepEqual(sanitize({ maxTokens: 512.4 }), { set: { maxTokens: 512 }, clear: [] })
  // Unknown keys are simply not settings.
  assert.deepEqual(sanitize({ nonsense: 1 }), { set: {}, clear: [] })

  assert.throws(() => sanitize({ temperature: 'hot' }), /must be a number/)
  assert.throws(() => sanitize({ topP: 4 }), /between 0 and 1/)
  assert.throws(() => sanitize({ model: '' }), /non-empty string/)
  assert.throws(() => sanitize({ stop: [1] }), /array of strings/)
})

test('the reply-shaping settings round-trip through the sanitizer', () => {
  // Booleans: on, off, clear. A non-boolean is refused rather than coerced —
  // a `"true"` string would read as on forever and never say why.
  assert.deepEqual(sanitize({ trimSentences: true }), { set: { trimSentences: true }, clear: [] })
  assert.deepEqual(sanitize({ squashSystemMessages: false }), { set: { squashSystemMessages: false }, clear: [] })
  assert.deepEqual(sanitize({ trimSentences: null }), { set: {}, clear: ['trimSentences'] })
  assert.throws(() => sanitize({ trimSentences: 'yes' }), /must be a boolean/)
  assert.throws(() => sanitize({ squashSystemMessages: 1 }), /must be a boolean/)

  // The continue separator travels as the word, never the literal — the same
  // refuse-garbage rule as every other field.
  for (const word of ['none', 'space', 'newline', 'double']) {
    assert.deepEqual(sanitize({ continuePostfix: word }), { set: { continuePostfix: word }, clear: [] })
  }
  assert.deepEqual(sanitize({ continuePostfix: null }), { set: {}, clear: ['continuePostfix'] })
  assert.throws(() => sanitize({ continuePostfix: 'semicolon' }), /must be one of/)
  assert.throws(() => sanitize({ continuePostfix: '  ' }), /must be one of/)
})

test('an explicit null asks for the override to be removed, not for a null value', () => {
  // The distinction a "use host default" control depends on: absent means leave
  // it alone, null means stop overriding it. Collapsing the two would make that
  // control silently do nothing.
  assert.deepEqual(sanitize({ temperature: null }), { set: {}, clear: ['temperature'] })
  assert.deepEqual(sanitize({}), { set: {}, clear: [] })
  assert.deepEqual(
    sanitize({ temperature: null, topP: 0.9, stop: null, model: null }),
    { set: { topP: 0.9 }, clear: ['model', 'temperature', 'stop'] },
  )
})

test('a card overrides the preset’s main prompt and post-history instructions', () => {
  const overridden = applyCardOverrides(DEFAULT_PRESET, card({
    system_prompt: 'You are Aria, and you never break character.',
    post_history_instructions: 'Reply in two paragraphs.',
  }))

  const main = overridden.prompts.find(item => item.identifier === 'main')
  const jailbreak = overridden.prompts.find(item => item.identifier === 'jailbreak')
  assert.equal(main?.content, 'You are Aria, and you never break character.')
  assert.equal(jailbreak?.content, 'Reply in two paragraphs.')
  // The input is untouched, or the override would leak into the next chat.
  assert.match(DEFAULT_PRESET.prompts.find(item => item.identifier === 'main')?.content ?? '', /fictional roleplay/)
})

test('a preset item that forbids overrides keeps its own text', () => {
  const preset = {
    prompts: [{ identifier: 'main', role: 'system' as const, content: 'The preset wins.', forbid_overrides: true }],
  }
  const overridden = applyCardOverrides(preset, card({ system_prompt: 'The card wins.' }))

  assert.equal(overridden.prompts[0]?.content, 'The preset wins.')
})

test('the character’s definition reaches the system prompt with macros expanded', () => {
  const { contributions } = buildPrompt({
    card: card(),
    preset: DEFAULT_PRESET,
    userName: 'Traveller',
    characterName: 'Aria',
    history: [{ role: 'user', text: 'Hello?' }],
    count: text => text.length,
    worldInfoBudget: 1000,
  })

  const system = contributions.filter(item => item.placement.kind === 'system').map(item => item.text).join('\n')
  assert.match(system, /A retired cartographer\./)
  assert.match(system, /Dry, patient\./)
  assert.match(system, /map shop/)
  assert.match(system, /fictional roleplay between Aria and Traveller/, '{{char}} and {{user}} expanded')
  assert.doesNotMatch(system, /Do not send this to the model/, 'creator notes are for the author')
})

test('a world book entry activates on a keyword and lands where its position says', () => {
  const withBook = card({
    character_book: {
      extensions: {},
      entries: [
        {
          keys: ['lighthouse'],
          content: 'The lighthouse has been dark for nine years.',
          enabled: true,
          insertion_order: 100,
          extensions: { position: 0 },
        },
        {
          keys: ['harbour'],
          content: 'Never mentioned.',
          enabled: true,
          insertion_order: 100,
          extensions: { position: 0 },
        },
      ],
    },
  })

  assert.equal(scanEntriesOf(withBook).length, 2)

  const { contributions, activated } = buildPrompt({
    card: withBook,
    preset: DEFAULT_PRESET,
    userName: 'Traveller',
    characterName: 'Aria',
    history: [{ role: 'user', text: 'Tell me about the lighthouse.' }],
    count: text => text.length,
    worldInfoBudget: 1000,
  })

  assert.deepEqual(activated.map(entry => entry.content), ['The lighthouse has been dark for nine years.'])
  const system = contributions.filter(item => item.placement.kind === 'system').map(item => item.text).join('\n')
  assert.match(system, /dark for nine years/)
  assert.doesNotMatch(system, /Never mentioned/)
})

test('an atDepth entry becomes a depth injection, not a system section', () => {
  const withBook = card({
    character_book: {
      extensions: {},
      entries: [{
        keys: ['ring'],
        content: '[The ring is cold to the touch.]',
        enabled: true,
        insertion_order: 100,
        extensions: { position: 4, depth: 2, role: 0 },
      }],
    },
  })

  const { contributions } = buildPrompt({
    card: withBook,
    preset: DEFAULT_PRESET,
    userName: 'Traveller',
    characterName: 'Aria',
    history: [{ role: 'user', text: 'I turn the ring over.' }],
    count: text => text.length,
    worldInfoBudget: 1000,
  })

  const injected = contributions.find(item => item.text.includes('cold to the touch'))
  // Depth placement is the whole reason Iris assembles messages itself; a
  // system section here would put the note in the wrong place entirely.
  assert.deepEqual(injected?.placement, { kind: 'depth', depth: 2, role: 'system', order: 0 })
})

test('a card’s depth prompt is injected at the depth it asks for', () => {
  const { contributions } = buildPrompt({
    card: card({ extensions: { depth_prompt: { depth: 4, prompt: '{{char}} is limping.', role: 'system' } } }),
    preset: DEFAULT_PRESET,
    userName: 'Traveller',
    characterName: 'Aria',
    history: [{ role: 'user', text: 'Hello?' }],
    count: text => text.length,
    worldInfoBudget: 1000,
  })

  const note = contributions.find(item => item.id === 'card.depthPrompt')
  assert.equal(note?.text, 'Aria is limping.')
  assert.deepEqual(note?.placement, { kind: 'depth', depth: 4, role: 'system', order: 1 })
})

test('a book Iris cannot read plays the character without it', () => {
  assert.deepEqual(scanEntriesOf(card({ character_book: { entries: 'not an array' } as never })), [])
  assert.deepEqual(scanEntriesOf(undefined), [])
})

/**
 * The id rule against the real library.
 *
 * Skipped without a SillyTavern install, like the other corpus checks. It earns
 * its place because the rule it guards was wrong in the expensive direction:
 * the original whitelist accepted every id Iris generates and rejected every
 * filename SillyTavern writes, so the failure was invisible from inside this
 * repo and total from outside it.
 *
 * Read from `IRIS_CORPUS`, not hardcoded. This was the one corpus gate that
 * ignored the variable, so `scripts/check-corpus-skips.mjs` — which forces
 * `IRIS_CORPUS` to a path that cannot exist — still ran it against the real
 * install here and skipped it on CI: the rehearsal counted one fewer skip
 * than the run it rehearses for.
 */
const ST_ROOT = `${process.env['IRIS_CORPUS'] ?? 'E:/sillyTavern/SillyTavern'}/data/default-user`

test('every real SillyTavern filename is a usable id', {
  skip: !existsSync(ST_ROOT) && `no SillyTavern profile at ${ST_ROOT}; point IRIS_CORPUS at an install to run this`,
}, async () => {
  const rejected: string[] = []
  let seen = 0

  const check = async (dir: string, extension: string): Promise<void> => {
    let names: string[]
    try {
      names = await readdir(dir)
    } catch {
      return
    }
    for (const name of names.filter(entry => entry.endsWith(extension))) {
      const id = name.slice(0, -extension.length)
      seen += 1
      if (!isSafeId(id)) rejected.push(id)
    }
  }

  await check(join(ST_ROOT, 'characters'), '.png')
  for (const character of await readdir(join(ST_ROOT, 'chats'))) {
    await check(join(ST_ROOT, 'chats', character), '.jsonl')
  }

  assert.ok(seen > 20, `read ${String(seen)} filenames from the library`)
  assert.deepEqual(rejected, [], `ids Iris would refuse to open: ${rejected.slice(0, 5).join(', ')}`)
})

test('a card’s {{original}} keeps the preset’s prompt instead of erasing it', () => {
  const preset = {
    prompts: [
      { identifier: 'main', role: 'system' as const, content: 'PRESET RULES.' },
      { identifier: 'jailbreak', role: 'system' as const, content: 'PRESET WRAP-UP.' },
    ],
  }
  const overridden = applyCardOverrides(preset, card({
    system_prompt: '{{original}}\n\nAnd Aria never breaks character.',
    post_history_instructions: 'Before finishing: {{original}}',
  }))

  // Upstream supplies the replaced text to the substitution as `original`
  // (`openai.js:1491-1492` reaching `PromptManager.js:1281-1284`), so a card
  // that writes the macro EXTENDS the preset rather than replacing it. Without
  // it the preset's main prompt vanishes silently and completely, which is the
  // failure this pins.
  assert.equal(
    overridden.prompts.find(item => item.identifier === 'main')?.content,
    'PRESET RULES.\n\nAnd Aria never breaks character.',
  )
  assert.equal(
    overridden.prompts.find(item => item.identifier === 'jailbreak')?.content,
    'Before finishing: PRESET WRAP-UP.',
  )
})

test('{{original}} yields once, and a card without it still replaces outright', () => {
  const preset = { prompts: [{ identifier: 'main', role: 'system' as const, content: 'ORIGINAL' }] }

  // One shot, as upstream's registry gives it: the second read falls through to
  // `@iris/macro`'s builtin, which yields '' — so the text is left for the
  // macro pass rather than filled a second time here.
  const twice = applyCardOverrides(preset, card({ system_prompt: 'A {{original}} B {{original}} C' }))
  assert.equal(twice.prompts[0]?.content, 'A ORIGINAL B {{original}} C')

  // And the ordinary case is untouched: no macro means a plain replacement,
  // which is what every card in the local corpus actually does.
  const plain = applyCardOverrides(preset, card({ system_prompt: 'The card wins.' }))
  assert.equal(plain.prompts[0]?.content, 'The card wins.')
})

test('presetScalarPatch carries squash_system_messages, which is a boolean', () => {
  // A checkbox in upstream's `settingsToUpdate` (`openai.js:380`). The numeric
  // loop's `typeof value === 'number'` guard dropped it silently, so switching
  // presets left the previous preset's squash running over the new prompt list.
  assert.equal(
    presetScalarPatch({ prompts: [], squash_system_messages: true })['squashSystemMessages'],
    true,
  )
  // `false` is a value, not an absence — the operator's own preset ships it.
  assert.equal(
    presetScalarPatch({ prompts: [], squash_system_messages: false })['squashSystemMessages'],
    false,
  )
  // Garbage is skipped rather than refused, like every other field here.
  assert.equal(
    Object.hasOwn(presetScalarPatch({ prompts: [], squash_system_messages: 'yes' }), 'squashSystemMessages'),
    false,
  )
  assert.equal(
    Object.hasOwn(presetScalarPatch({ prompts: [] }), 'squashSystemMessages'),
    false,
  )
})
