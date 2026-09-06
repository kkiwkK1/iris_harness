import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  createMacroContext,
  createMacroRegistry,
  createMemoryVariableStore,
  expandMacros,
  seededRandom,
  type MacroClock,
  type MacroContextInput,
  type MacroRandom,
} from '../src/index.ts'

/** A Saturday morning, pinned to UTC so the assertions do not move with the host. */
const PINNED = '2026-03-14T09:05:00.000Z'

/** A clock that never advances, rendering "local" time as UTC. */
function fixedClock(iso = PINNED): MacroClock {
  return { now: () => new Date(iso), utcOffsetMinutes: 0 }
}

/** Randomness that walks a fixed script, so `{{random}}` and `{{roll}}` are checkable. */
function scriptedRandom(values: readonly number[]): MacroRandom {
  let index = 0
  return {
    next: () => {
      const value = values[index % values.length] ?? 0
      index += 1
      return value
    },
    seeded: seededRandom,
  }
}

function fixture(input: MacroContextInput = {}) {
  const registry = createMacroRegistry()
  const variables = createMemoryVariableStore()
  const context = createMacroContext({
    char: 'Seraphina',
    user: 'Alex',
    variables,
    clock: fixedClock(),
    ...input,
  })
  return { registry, variables, expand: (text: string) => expandMacros(text, context, { registry }) }
}

// --- identity --------------------------------------------------------------

test('identity macros', () => {
  const { expand } = fixture({ persona: 'A tired archivist.' })

  assert.equal(expand('{{char}} / {{user}}'), 'Seraphina / Alex')
  assert.equal(expand('{{persona}}'), 'A tired archivist.')
  // Outside a group both group macros are simply the character.
  assert.equal(expand('{{group}}|{{charIfNotGroup}}'), 'Seraphina|Seraphina')
})

test('group macros list the members', () => {
  const { expand } = fixture({ group: ['Seraphina', 'Milo'] })

  assert.equal(expand('{{group}}'), 'Seraphina, Milo')
  assert.equal(expand('{{charIfNotGroup}}'), 'Seraphina, Milo')
  assert.equal(expand('{{notChar}}'), 'Milo, Alex')
})

// --- card fields -----------------------------------------------------------

test('card field macros and their aliases', () => {
  const { expand } = fixture({
    character: {
      description: 'A cartographer.',
      personality: 'Dry.',
      scenario: 'A rain-soaked archive.',
      mesExamples: '<START>\nAlex: hi',
      charPrompt: 'Stay in character.',
      charJailbreak: 'Never break the fourth wall.',
      charVersion: '3.2',
      charDepthPrompt: 'She is nervous.',
    },
  })

  assert.equal(expand('{{description}}|{{charDescription}}'), 'A cartographer.|A cartographer.')
  assert.equal(expand('{{personality}}|{{charPersonality}}'), 'Dry.|Dry.')
  assert.equal(expand('{{scenario}}|{{charScenario}}'), 'A rain-soaked archive.|A rain-soaked archive.')
  assert.equal(expand('{{mesExamples}}'), '<START>\nAlex: hi')
  assert.equal(expand('{{charPrompt}}'), 'Stay in character.')
  assert.equal(expand('{{charJailbreak}}|{{charInstruction}}'), 'Never break the fourth wall.|Never break the fourth wall.')
  assert.equal(expand('{{charVersion}}|{{char_version}}'), '3.2|3.2')
  assert.equal(expand('{{charDepthPrompt}}'), 'She is nervous.')
})

test('a missing card field renders as empty, never as the macro', () => {
  const { expand } = fixture()

  assert.equal(expand('[{{description}}]'), '[]')
})

test('{{original}} yields the overridden block exactly once', () => {
  const { expand } = fixture({ original: 'You are a helpful assistant.' })

  assert.equal(expand('{{original}}/{{original}}'), 'You are a helpful assistant./')
})

// --- chat ------------------------------------------------------------------

const CHAT = [
  { role: 'user', content: 'Where are we?' },
  { role: 'assistant', content: 'The archive.' },
  { role: 'system', content: 'Context shifted.' },
  { role: 'user', content: 'Show me the map.' },
  { role: 'assistant', content: 'She unrolls it.' },
] as const

test('chat macros', () => {
  const { expand } = fixture({ chat: CHAT, input: 'half-typed line' })

  assert.equal(expand('{{lastMessage}}'), 'She unrolls it.')
  assert.equal(expand('{{lastUserMessage}}'), 'Show me the map.')
  assert.equal(expand('{{lastCharMessage}}'), 'She unrolls it.')
  assert.equal(expand('{{lastMessageId}}'), '4')
  assert.equal(expand('{{allChatRange}}'), '0-4')
  assert.equal(expand('{{input}}'), 'half-typed line')
})

test('chat macros on an empty chat render as empty', () => {
  const { expand } = fixture({ chat: [] })

  assert.equal(expand('[{{lastMessage}}][{{lastMessageId}}]'), '[][]')
})

// --- time ------------------------------------------------------------------

test('time and date macros read the injected clock', () => {
  const { expand } = fixture()

  assert.equal(expand('{{time}}'), '9:05 AM')
  assert.equal(expand('{{date}}'), 'March 14, 2026')
  assert.equal(expand('{{weekday}}'), 'Saturday')
  assert.equal(expand('{{isotime}}'), '09:05')
  assert.equal(expand('{{isodate}}'), '2026-03-14')
  assert.equal(expand('{{datetimeformat::YYYY/MM/DD HH:mm:ss}}'), '2026/03/14 09:05:00')
  assert.equal(expand('{{datetimeformat YYYY-MM-DD}}'), '2026-03-14', 'the legacy space form still works')
})

test('UTC offsets, in both the modern and the legacy spelling', () => {
  const { expand } = fixture()

  assert.equal(expand('{{time::UTC+2}}'), '11:05 AM')
  assert.equal(expand('{{time_UTC+2}}'), '11:05 AM')
  assert.equal(expand('{{time_UTC-5}}'), '4:05 AM')
})

test('{{idleDuration}} measures from before the turn being answered', () => {
  const now = new Date(PINNED).getTime()
  const { expand } = fixture({
    chat: [
      { role: 'user', content: 'first', sendDate: now - 3 * 60 * 60 * 1000 },
      { role: 'assistant', content: 'reply' },
      // The message currently being answered is skipped, exactly as upstream
      // skips it — otherwise the answer would always be "a few seconds".
      { role: 'user', content: 'second', sendDate: now - 1000 },
    ],
  })

  assert.equal(expand('{{idleDuration}}'), '3 hours')
  assert.equal(expand('{{idle_duration}}'), '3 hours')
})

test('{{idleDuration}} falls back to "just now"', () => {
  const { expand } = fixture({ chat: [] })

  assert.equal(expand('{{idleDuration}}'), 'just now')
})

// --- variables -------------------------------------------------------------

test('variable macros mutate the injected store', () => {
  const { expand, variables } = fixture()

  assert.equal(expand('{{setvar::hp::10}}'), '', 'setting renders as nothing')
  assert.equal(variables.local.get('hp'), '10')

  assert.equal(expand('{{getvar::hp}}'), '10')
  assert.equal(expand('{{addvar::hp::5}}'), '')
  assert.equal(variables.local.get('hp'), '15')

  assert.equal(expand('{{incvar::hp}}'), '16', 'incrementing renders the new value')
  assert.equal(expand('{{decvar::hp}}'), '15')
  assert.equal(expand('{{hasvar::hp}}|{{hasvar::mp}}'), 'true|false')
  assert.equal(expand('{{deletevar::hp}}'), '')
  assert.equal(variables.local.has('hp'), false)
})

test('{{addvar}} appends to a JSON array and concatenates non-numbers', () => {
  const { expand, variables } = fixture()

  variables.set('local', 'bag', '["rope"]')
  expand('{{addvar::bag::lamp}}')
  assert.equal(variables.local.get('bag'), '["rope","lamp"]')

  variables.set('local', 'name', 'Ser')
  expand('{{addvar::name::aphina}}')
  assert.equal(variables.local.get('name'), 'Seraphina')
})

test('an unset variable reads as empty and counting starts from zero', () => {
  const { expand, variables } = fixture()

  assert.equal(expand('[{{getvar::nothing}}]'), '[]')
  assert.equal(expand('{{incvar::turn}}'), '1')
  assert.equal(variables.local.get('turn'), '1')
})

test('the global family is a separate tier', () => {
  const { expand, variables } = fixture()

  expand('{{setglobalvar::mood::calm}}{{setvar::mood::frantic}}')
  assert.equal(variables.global.get('mood'), 'calm')
  assert.equal(variables.local.get('mood'), 'frantic')

  assert.equal(expand('{{getglobalvar::mood}}|{{getvar::mood}}'), 'calm|frantic')
  assert.equal(expand('{{addglobalvar::count::2}}{{incglobalvar::count}}'), '3')
  assert.equal(expand('{{decglobalvar::count}}'), '2')
  assert.equal(expand('{{hasglobalvar::mood}}'), 'true')
  assert.equal(expand('{{deleteglobalvar::mood}}'), '')
  assert.equal(variables.global.has('mood'), false)
})

test('a variable macro with no name is left alone rather than acting on ""', () => {
  const { expand } = fixture()

  assert.equal(expand('{{getvar}}'), '{{getvar}}')
  assert.equal(expand('{{setvar::hp}}'), '{{setvar::hp}}')
})

// --- random ----------------------------------------------------------------

test('{{random}} re-rolls on every expansion', () => {
  const { expand } = fixture({ random: scriptedRandom([0, 0.5, 0.9]) })

  assert.equal(expand('{{random::a::b::c}}'), 'a')
  assert.equal(expand('{{random::a::b::c}}'), 'b')
  assert.equal(expand('{{random::a::b::c}}'), 'c')
})

test('{{random}} accepts both separator forms', () => {
  const { expand } = fixture({ random: scriptedRandom([0.99]) })

  assert.equal(expand('{{random::a::b::c}}'), 'c')
  assert.equal(expand('{{random:a, b, c}}'), 'c', 'commas, with the items trimmed')
  assert.equal(expand('{{random:a::b::c}}'), 'c', ':: wins over , when both could apply')
  assert.equal(expand('{{random:a\\,b, c}}'), 'c')
})

test('an escaped comma stays inside its option', () => {
  const { expand } = fixture({ random: scriptedRandom([0]) })

  assert.equal(expand('{{random:one\\,two, three}}'), 'one,two')
})

test('{{pick}} is stable for a given text and position', () => {
  const context: MacroContextInput = {
    chatId: 'chat-7f3a',
    // Proof that {{pick}} never touches fresh entropy: doing so would throw.
    random: {
      next: () => {
        throw new Error('{{pick}} must not consume fresh entropy')
      },
      seeded: seededRandom,
    },
  }
  const a = fixture(context)
  const b = fixture(context)
  const text = 'Her eyes are {{pick::blue::green::grey}}.'

  const first = a.expand(text)
  assert.equal(a.expand(text), first, 'the same prompt rebuilt gives the same pick')
  assert.equal(b.expand(text), first, 'and so does a fresh registry for the same chat')
  assert.match(first, /^Her eyes are (blue|green|grey)\.$/)
})

test('{{pick}} varies with position and with the chat it sits in', () => {
  const digits = '::0::1::2::3::4::5::6::7::8::9'
  const text = `{{pick${digits}}}|{{pick${digits}}}`

  let sawDisagreement = false
  const perChat = new Set<string>()
  for (let index = 0; index < 8; index += 1) {
    const result = fixture({ chatId: `chat-${index}` }).expand(text)
    perChat.add(result)
    const [left, right] = result.split('|')
    if (left !== right) sawDisagreement = true
  }

  // Ten options each, so two picks agreeing is a 1-in-10 coincidence rather
  // than proof of a shared seed — but agreeing eight times in a row is not.
  assert.ok(sawDisagreement, 'two picks at different offsets must not share a seed')
  assert.ok(perChat.size > 1, 'and a different chat must be able to pick differently')
})

test('{{roll}} stays within the formula bounds', () => {
  const low = fixture({ random: scriptedRandom([0]) })
  const high = fixture({ random: scriptedRandom([0.999999]) })

  assert.equal(low.expand('{{roll::2d6}}'), '2')
  assert.equal(high.expand('{{roll::2d6}}'), '12')
  assert.equal(low.expand('{{roll::d6}}'), '1')
  assert.equal(high.expand('{{roll::d6}}'), '6')
  assert.equal(low.expand('{{roll::20}}'), '1', 'a bare number means one die of that size')
  assert.equal(high.expand('{{roll::3d6+4}}'), '22')
  assert.equal(high.expand('{{roll:1d20}}'), '20')
  assert.equal(high.expand('{{roll 1d20}}'), '20')
})

test('{{roll}} bounds hold against real randomness', () => {
  const { expand } = fixture()

  for (let attempt = 0; attempt < 200; attempt += 1) {
    const total = Number(expand('{{roll::2d6}}'))
    assert.ok(total >= 2 && total <= 12, `2d6 rolled ${total}`)
  }
})

test('an unusable roll formula renders as empty, as upstream does', () => {
  const { expand } = fixture()

  assert.equal(expand('[{{roll::banana}}]'), '[]')
  assert.equal(expand('{{roll}}'), '{{roll}}', 'with no formula at all it is not a roll')
})

// --- formatting ------------------------------------------------------------

test('whitespace and no-op macros', () => {
  const { expand } = fixture()

  assert.equal(expand('a{{newline}}b'), 'a\nb')
  assert.equal(expand('a{{newline::3}}b'), 'a\n\n\nb')
  assert.equal(expand('a{{space}}b'), 'a b')
  assert.equal(expand('a{{space::4}}b'), 'a    b')
  assert.equal(expand('a{{noop}}b'), 'ab')
  assert.equal(expand('a{{space::x}}b'), 'a{{space::x}}b', 'a nonsense count is not a space macro')
})

test('comments vanish, including the multi-line form', () => {
  const { expand } = fixture()

  assert.equal(expand('before {{// a note to self}}after'), 'before after')
  assert.equal(expand('{{//\nspanning\nlines\n}}kept'), 'kept')
  assert.equal(expand('{{comment}}kept'), 'kept')
})

test('{{reverse}} works on code points, not code units', () => {
  const { expand } = fixture()

  assert.equal(expand('{{reverse::I am Lana}}'), 'anaL ma I')
  assert.equal(expand('{{reverse:abc}}'), 'cba')
  assert.equal(expand('{{reverse::a🌙b}}'), 'b🌙a')
})

// --- floor addressing (B4) -------------------------------------------------

const SWIPED_CHAT = [
  { role: 'user', content: 'Where are we?' },
  { role: 'assistant', content: 'The archive.', swipes: 3, swipeId: 1 },
  { role: 'user', content: 'Show me the map.' },
  { role: 'assistant', content: 'She unrolls it.', swipes: 2, swipeId: 0 },
] as const

test('the swipe pair reads the newest floor, 1-based as upstream', () => {
  const { expand } = fixture({ chat: SWIPED_CHAT })

  assert.equal(expand('{{lastSwipeId}}'), '2')
  assert.equal(expand('{{currentSwipeId}}'), '1')
})

test('a newest floor without candidates leaves the swipe pair empty', () => {
  const { expand } = fixture({ chat: [SWIPED_CHAT[2]] })

  assert.equal(expand('[{{lastSwipeId}}][{{currentSwipeId}}]'), '[][]')
  assert.equal(expand('[{{lastSwipeId}}]'), '[]', 'an empty chat is empty, not zero')
})

test('the context-boundary pair: firstIncluded from the host, firstDisplayed from the log', () => {
  const { expand } = fixture({ chat: SWIPED_CHAT })

  // Before any generation has run, upstream's metadata has no value yet.
  assert.equal(expand('{{firstIncludedMessageId}}'), '')
  const wired = fixture({ chat: SWIPED_CHAT, firstIncludedMessageId: 5 })
  assert.equal(wired.expand('{{firstIncludedMessageId}}'), '5')

  // The shell mounts every floor, so the first displayed one is floor 0 —
  // exactly what upstream's DOM read answers.
  assert.equal(expand('{{firstDisplayedMessageId}}'), '0')
})

test('firstDisplayedMessageId on an empty chat renders as empty', () => {
  const { expand } = fixture({ chat: [] })

  assert.equal(expand('[{{firstDisplayedMessageId}}]'), '[]')
})

// --- timeDiff (B4) ---------------------------------------------------------

test('{{timeDiff}} humanizes the signed difference between two times', () => {
  const { expand } = fixture()

  assert.equal(expand('{{timeDiff::2023-01-01 15:00:00::2023-01-01 12:00:00}}'), 'in 3 hours')
  assert.equal(expand('{{timeDiff::2023-01-01 12:00:00::2023-01-01 15:00:00}}'), '3 hours ago')
  assert.equal(expand('{{ timeDiff :: 2023-01-02 :: 2023-01-01 }}'), 'in a day')
})

test('{{timeDiff}} with fewer than two times stays standing', () => {
  const { expand } = fixture()

  assert.equal(expand('a {{timeDiff}} b'), 'a {{timeDiff}} b')
  assert.equal(expand('a {{timeDiff::2023-01-01}} b'), 'a {{timeDiff::2023-01-01}} b')
})

// --- outlet (B4) -----------------------------------------------------------

test('{{outlet::key}} reads the outlet the scan produced', () => {
  const seen: string[] = []
  const { expand } = fixture({
    outlet: key => {
      seen.push(key)
      return key === 'achievements' ? 'She has earned three.' : ''
    },
  })

  assert.equal(expand('{{outlet::achievements}}'), 'She has earned three.')
  assert.equal(expand('{{outlet:: achievements }}'), 'She has earned three.', 'the key is trimmed before the lookup')
  assert.deepEqual(seen, ['achievements', 'achievements'])
  assert.equal(expand('{{outlet::unknown}}'), '', 'a key with no bucket is empty, as upstream')
})

test('{{outlet}} with no reader renders empty, and bare stays standing', () => {
  const { expand } = fixture()

  assert.equal(expand('x{{outlet::key}}y'), 'xy')
  assert.equal(expand('a {{outlet}} b'), 'a {{outlet}} b', 'no key is no macro, as upstream')
})

// --- token budget (B4) -----------------------------------------------------

test('the budget macros report the assembler budget', () => {
  const { expand } = fixture({ tokenBudget: { context: 8192, response: 1024 } })

  assert.equal(expand('{{maxContext}}|{{maxContextTokens}}'), '8192|8192')
  assert.equal(expand('{{maxResponse}}|{{maxResponseTokens}}'), '1024|1024')
  assert.equal(expand('{{maxPrompt}}|{{maxPromptTokens}}'), '7168|7168')
})

test('the budget macros render empty when no route is configured', () => {
  const { expand } = fixture()

  assert.equal(expand('[{{maxContext}}][{{maxResponse}}][{{maxPrompt}}]'), '[][][]')
})

// --- the two engine invariants, restated for the B4 macros -----------------

test('{{noop}} is empty no matter what it carries, and emits nothing to rescan', () => {
  const { expand, variables } = fixture()

  assert.equal(expand('a{{noop}}b'), 'ab')
  // The argument is expanded (inner-first) and then dropped whole: whatever a
  // card hides inside a noop must never surface, let alone execute.
  assert.equal(expand('a{{noop::{{char}}}}b'), 'ab')
  assert.equal(expand('{{noop}}'), '')
  assert.equal(variables.local.size, 0)
})

test('{{reverse}} can spell a macro and the engine must not run it', () => {
  const { expand, variables } = fixture()
  // A value whose reversal reads as `{{char}}`: a rescanning engine would
  // substitute the name here, and the whole advantage Iris keeps is that it
  // does not — the reversed text is data, however inconvenient its spelling.
  variables.set('local', 'payload', '}}rahc{{')

  assert.equal(expand('{{reverse::{{getvar::payload}}}}'), '{{char}}')
})
