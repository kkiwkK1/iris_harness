import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { CharacterCard } from '@iris/character'
import type { IrisEvent, RegexScriptView } from '@iris/protocol'
import type { StreamFn } from '@iris/turn'

import { ChatStore } from '../src/chats.ts'
import { ExtensionSettingsStore } from '../src/context.ts'
import { CharacterLibrary } from '../src/library.ts'
import { scriptsOf } from '../src/regex.ts'
import { ScriptPolicyStore } from '../src/scripts.ts'
import { IrisAppService, type Handlers } from '../src/service.ts'
import { SettingsStore } from '../src/settings.ts'

/**
 * The card's own regex tier, and the two switches over it.
 *
 * Upstream's second tier lives in the card (`data.extensions.regex_scripts`)
 * and runs **only** for a character the user has put on
 * `character_allowed_regex` — `getRegexedString` is the one caller that asks
 * for `allowedOnly: true` (`extensions/regex/engine.js:346`, gate at `:115`).
 * This host ran the tier unconditionally until 2026-09-08, so a user had no way
 * to refuse a card's rules short of editing the card.
 *
 * **Why this tier and not the global one.** Measured over the 19 local cards:
 * 15 carry this tier, 173 rules between them, and the same install's global
 * tier — the only one the shell could see — was empty. So this was where
 * essentially all of a real user's regex lived.
 *
 * What is pinned here: the gate, the per-rule override, the direction of each
 * default, and the two properties that make the feature honest — the list is
 * reported whether or not it is allowed, and a rule comes back verbatim so its
 * export is a file an install accepts.
 */

/** Two rules, one shipped on and one shipped off, in the shape a card stores. */
const RULES: RegexScriptView[] = [
  {
    id: 'rule-on',
    scriptName: 'hide the bookkeeping',
    findRegex: '/HIDE/g',
    replaceString: '',
    trimStrings: [],
    placement: [2],
    disabled: false,
    markdownOnly: true,
    promptOnly: false,
    runOnEdit: false,
    substituteRegex: 0,
    minDepth: null,
    maxDepth: null,
    // A key no field in this shell renders. It rides along, or the export half
    // of the migration cycle silently strips it.
    'some-future-key': { nested: [1, 2, 3] },
  } as unknown as RegexScriptView,
  {
    id: 'rule-off',
    scriptName: 'shipped switched off',
    findRegex: '/OFF/g',
    replaceString: 'on',
    placement: [2],
    disabled: true,
  },
]

/** A V2 card file carrying whatever the test needs. */
function cardFile(extensions: Record<string, unknown> = {}): string {
  return JSON.stringify({
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      name: 'Aria', description: '', personality: '', scenario: '',
      first_mes: 'Hello.', mes_example: '', creator_notes: '', system_prompt: '',
      post_history_instructions: '', alternate_greetings: [], tags: [],
      creator: '', character_version: '1', extensions,
    },
  })
}

/** A stream that replies with one fixed text. */
function scriptedStream(reply: string): StreamFn {
  return async function* (_options: GenerateOptions): AsyncIterable<StreamChunk> {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: reply }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: reply } }
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** A host over a throwaway folder holding one card with the two rules above. */
async function fixture(t: TestContext, options: { rules?: unknown } = {}): Promise<{
  dir: string
  handlers: Handlers
  scripts: ScriptPolicyStore
  chats: ChatStore
  chatId: string
  events: IrisEvent[]
}> {
  const dir = await mkdtemp(join(tmpdir(), 'iris-scoped-regex-'))
  t.after(async () => { await rm(dir, { recursive: true, force: true }) })
  await mkdir(join(dir, 'characters'), { recursive: true })
  // `'rules' in options`, not `?? RULES`: a caller that passes `undefined`
  // deliberately means "a card with no tier at all", and a defaulting `??`
  // would silently hand it the two-rule card and pass the assertion it was
  // written to disprove.
  const rules = 'rules' in options ? options.rules : RULES
  await writeFile(
    join(dir, 'characters', 'aria.json'),
    cardFile({ regex_scripts: rules }),
    'utf8',
  )

  const library = new CharacterLibrary(join(dir, 'characters'), '/iris/avatar')
  const settingsStore = new ExtensionSettingsStore(join(dir, 'extension-settings.json'))
  const scripts = new ScriptPolicyStore(join(dir, 'script-policy.json'))
  const chats = new ChatStore(
    join(dir, 'chats'), library,
    undefined, undefined, undefined,
    () => [], undefined, undefined,
    () => settingsStore.globalRegex(),
    undefined, undefined,
    characterId => scripts.scopedRegex(characterId),
  )
  const events: IrisEvent[] = []
  const handlers = new IrisAppService({
    stream: scriptedStream('HIDE kept OFF'),
    library, chats, scripts,
    extensionSettings: settingsStore,
    settings: new SettingsStore(join(dir, 'settings.json'), { provider: 'test', model: 'test-model' }),
    broadcast: event => { events.push(event) },
    userName: 'Traveller',
  }).handlers()

  const created = await handlers['chat.create']({ characterId: 'aria' })
  return { dir, handlers, scripts, chats, chatId: created.view.chatId, events }
}

/** The card as `scriptsOf` takes it. */
function decoded(rules: unknown = RULES): CharacterCard {
  return JSON.parse(cardFile({ regex_scripts: rules })) as CharacterCard
}

// ── the gate ────────────────────────────────────────────────────────────────

test('a card’s tier runs when nothing has been said about it, and is refused when it has', () => {
  // Absent means allowed, which is this host's default and **not** upstream's.
  // The reasoning is in the host ledger §30; what is pinned here is that the
  // three states are three, so a later round that changes the default has to
  // change this line and say why.
  assert.equal(scriptsOf(decoded(), []).length, 2, 'an unasked card’s rules did not run')
  assert.equal(
    scriptsOf(decoded(), [], { allowed: true, enabled: {} }).length,
    2,
    'an allowed card’s rules did not run',
  )
  assert.equal(
    scriptsOf(decoded(), [], { allowed: false, enabled: {} }).length,
    0,
    'a refused card’s rules ran anyway — the gate does nothing',
  )
})

test('the user’s per-rule switch overrides the card’s, in both directions', () => {
  const off = scriptsOf(decoded(), [], { allowed: true, enabled: { 'rule-on': false } })
  assert.equal(off.length, 2, 'a switched-off rule should still be handed to the engine, marked')
  assert.equal(
    off.find(rule => rule.id === 'rule-on')?.disabled,
    true,
    'the user switched a rule off and it is still enabled',
  )
  // The other direction, which is the half a one-way override would miss: the
  // card shipped this rule off and the user turned it on.
  const on = scriptsOf(decoded(), [], { allowed: true, enabled: { 'rule-off': true } })
  assert.equal(
    on.find(rule => rule.id === 'rule-off')?.disabled,
    false,
    'the user switched a card-disabled rule on and it stayed off',
  )
})

test('a rule the user has said nothing about is handed over by identity', () => {
  // The verbatim contract, at the object level. A composer that copied every
  // rule would be a place a key could be dropped, and the corpus's rules carry
  // keys this host does not read.
  const card = decoded()
  const stored = card.data.extensions.regex_scripts as RegexScriptView[]
  const composed = scriptsOf(card, [], { allowed: true, enabled: {} })
  assert.equal(composed[0], stored[0], 'an untouched rule was copied rather than passed through')
  // And a touched one is a copy, so the card's own object is never mutated.
  const touched = scriptsOf(card, [], { allowed: true, enabled: { 'rule-on': false } })
  assert.notEqual(touched[0], stored[0], 'the override was written into the card’s own object')
  assert.equal(stored[0]?.disabled, false, 'the card’s stored rule was mutated in place')
})

// ── the wire surface ────────────────────────────────────────────────────────

test('the list is reported whether or not the tier is allowed', async (t) => {
  const { handlers } = await fixture(t)
  const before = await handlers['regex.scopedList']({ characterId: 'aria' })
  assert.equal(before.allowed, true, 'a card nobody has decided about reads as refused')
  assert.equal(before.scripts.length, 2)

  const after = await handlers['regex.setScopedAllowed']({ characterId: 'aria', allowed: false })
  assert.equal(after.allowed, false)
  // The assertion this test exists for. Upstream's own panel lists a refused
  // tier — `getRegexScripts` defaults to `allowedOnly: false` — and a refused
  // tier that answered with an empty list would read as a card carrying no
  // rules at all, with the control that reverses the decision sitting over
  // nothing.
  assert.equal(
    after.scripts.length,
    2,
    'a refused tier answered with an empty list, which reads as a card with no rules',
  )
})

test('the two switches are reported separately, so “why is this off” has an answer', async (t) => {
  const { handlers } = await fixture(t)
  const listed = await handlers['regex.scopedList']({ characterId: 'aria' })
  const on = listed.scripts.find(row => row.script.id === 'rule-on')
  const off = listed.scripts.find(row => row.script.id === 'rule-off')
  assert.ok(on !== undefined && off !== undefined, 'the fixture’s two rules did not both arrive')
  assert.deepEqual(
    { byCard: on.enabledByCard, effective: on.enabled },
    { byCard: true, effective: true },
  )
  assert.deepEqual(
    { byCard: off.enabledByCard, effective: off.enabled },
    { byCard: false, effective: false },
    'a rule the card shipped switched off is not reported as the card’s decision',
  )

  await handlers['regex.setScopedEnabled']({ characterId: 'aria', scriptId: 'rule-off', enabled: true })
  const again = await handlers['regex.scopedList']({ characterId: 'aria' })
  const flipped = again.scripts.find(row => row.script.id === 'rule-off')
  assert.deepEqual(
    { byCard: flipped?.enabledByCard, effective: flipped?.enabled },
    { byCard: false, effective: true },
    'the card’s own flag moved when the user overrode it',
  )
})

test('a rule comes back verbatim, so its export is a file an install accepts', async (t) => {
  const { handlers } = await fixture(t)
  const listed = await handlers['regex.scopedList']({ characterId: 'aria' })
  const row = listed.scripts.find(entry => entry.script.id === 'rule-on')
  assert.deepEqual(
    row?.script,
    RULES[0],
    'the projection dropped or reshaped a field, so an export of it would be lossy',
  )
})

test('a decision about a rule the card does not carry is refused, not stored', async (t) => {
  const { handlers, dir } = await fixture(t)
  await assert.rejects(
    handlers['regex.setScopedEnabled']({ characterId: 'aria', scriptId: 'invented', enabled: false }),
    /invented/,
  )
  // And nothing was written: a policy file that accumulates ids from typos and
  // stale cards is a policy file nobody can audit.
  const written = await readFile(join(dir, 'script-policy.json'), 'utf8').catch(() => '{}')
  assert.doesNotMatch(written, /invented/, 'the refused id was stored anyway')
})

test('a card that ships no rules reads as an empty tier rather than a refusal', async (t) => {
  const { handlers } = await fixture(t, { rules: undefined })
  const listed = await handlers['regex.scopedList']({ characterId: 'aria' })
  assert.deepEqual(listed, { scripts: [], allowed: true })
})

test('a malformed rule is dropped rather than repaired', async (t) => {
  // `findRegex` and `replaceString` are what the engine reads on every run, and
  // upstream's own importer refuses a rule missing them. Dropped rather than
  // defaulted, because a repaired rule is a rule the card's author did not
  // write — and it would run.
  const { handlers } = await fixture(t, {
    rules: [{ id: 'a', scriptName: 'no pattern' }, RULES[0]],
  })
  const listed = await handlers['regex.scopedList']({ characterId: 'aria' })
  assert.equal(listed.scripts.length, 1, 'the rule with no pattern was kept')
  assert.equal(listed.scripts[0]?.script.id, 'rule-on')
})

// ── the pipeline ────────────────────────────────────────────────────────────

test('refusing the tier reaches a conversation that is already open', async (t) => {
  const { handlers, chatId } = await fixture(t)
  // Generate once with the tier allowed: the display-only rule strips HIDE.
  const generated = await handlers['chat.send']({ chatId, text: 'go' })
  assert.ok(generated !== undefined)
  const before = await handlers['chat.open']({ chatId })
  const shown = (text: unknown): string => String(text)
  const lastBefore = before.view.messages.at(-1)
  assert.doesNotMatch(shown(lastBefore?.text), /HIDE/, 'the card’s display rule did not run at all')

  // Refuse the tier. The chat is still open, so this is the path that has to
  // reach it — upstream's answer to the same problem is `reloadCurrentChat()`.
  await handlers['regex.setScopedAllowed']({ characterId: 'aria', allowed: false })
  const after = await handlers['chat.open']({ chatId })
  assert.match(
    shown(after.view.messages.at(-1)?.text),
    /HIDE/,
    'the refusal did not reach the open conversation: it is still running the old rules',
  )
})

test('an open conversation is re-announced when the tier is refused', async (t) => {
  const { handlers, chatId, events } = await fixture(t)
  await handlers['chat.send']({ chatId, text: 'go' })
  const before = events.filter(event => event.type === 'chat.updated').length
  await handlers['regex.setScopedAllowed']({ characterId: 'aria', allowed: false })
  const after = events.filter(event => event.type === 'chat.updated').length
  assert.ok(
    after > before,
    'no page was told to re-render, so an open reader keeps seeing text the old rules produced',
  )
})
