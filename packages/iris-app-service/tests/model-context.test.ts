/**
 * The model's own context window: where it is read from, and what it does to
 * the window a chat assembles under.
 *
 * The reported case this exists for: a conversation on `deepseek-v4-flash` — a
 * model DeepSeek documents at 1M — assembling against 2 000 000 tokens, because
 * a preset switched earlier had written that number onto the global settings
 * layer and nothing clamped it or said where it came from.
 *
 * @module @iris/app-service/tests/model-context
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, type TestContext } from 'node:test'

import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { GenerationSettings, IrisEvent } from '@iris/protocol'
import { MAX_CONTEXT_WINDOW, requestSchemas } from '@iris/protocol'
import type { StreamFn } from '@iris/turn'

import { CharacterLibrary } from '../src/library.ts'
import {
  CONTEXT_LENGTH_FIELDS,
  MODEL_CONTEXT_TABLE,
  modelContextFromRow,
  modelContextFromTable,
  resolveWindow,
} from '../src/model-context.ts'
import { IrisAppService, presetScalarPatch, type Handlers } from '../src/service.ts'
import { SettingsStore } from '../src/settings.ts'
import { materialisingChatStore } from './support/materialising-store.ts'

const HERE = dirname(fileURLToPath(import.meta.url))

/** Settings with only the two required fields, plus whatever a case is about. */
function settings(over: Partial<GenerationSettings> = {}): GenerationSettings {
  return { provider: 'default', model: 'deepseek-v4-flash', ...over }
}

// --------------------------------------------------------------- the table

test('the table answers for the model the report was about, with the documented number', () => {
  const found = modelContextFromTable('deepseek-v4-flash')
  assert.ok(found !== undefined, 'the table does not know deepseek-v4-flash')
  // 1M, as DeepSeek's own pricing page writes it and as upstream's `max_1mil`
  // spells it. Not 1 048 576: the page says "1M" and gives no exact integer, so
  // the binary reading would be this host's invention.
  assert.equal(found.tokens, 1_000_000)
  assert.match(found.row.source, /api-docs\.deepseek\.com/, 'the row does not name where its number came from')
})

test('a prefix match reaches the whole family, including the dated and vision ids', () => {
  for (const id of ['deepseek-v4-flash-0731', 'deepseek-v4-flash-vision-exp', 'deepseek-v4-pro']) {
    assert.equal(modelContextFromTable(id)?.tokens, 1_000_000, `${id} did not match the DeepSeek family`)
  }
})

test('the lookup folds case, which upstream never has to', () => {
  // Upstream's regexes run against whatever its own `<select>` stored, so case
  // never varies there. A window read out of a hand-edited settings file or an
  // id copied from a vendor's docs does vary, and a clamp that switched off
  // depending on capitalisation would be worse than no clamp.
  for (const id of ['DeepSeek-V4-Flash', 'DEEPSEEK-V4-PRO', '  deepseek-v4-flash  ']) {
    assert.equal(modelContextFromTable(id)?.tokens, 1_000_000, `${id} was not folded`)
  }
})

test('a model the table has never heard of returns undefined, not a safe default', () => {
  /*
   * The property the whole table is written around. Upstream's
   * `getMaxContextOpenAI` ends `return max_128k; // Safe default for most
   * modern models` (openai.js:4996), which silently cuts every model released
   * after that line was written down to 128k. Here an unknown id clamps
   * nothing, so a new 1M model works on the day it ships.
   */
  for (const id of ['local/qwen3-8b', 'some-model-nobody-has-heard-of', 'llama-4-maverick', '']) {
    assert.equal(modelContextFromTable(id), undefined, `${id} was given a made-up window`)
  }
})

test('upstream’s ordering is preserved where it decides the answer', () => {
  // openai.js tests `/gpt-3\.5-turbo-1106/` (16 383) before `/gpt-3/` (4 095).
  // Swapping the two rows changes the answer for a real id, which is why the
  // table is transcribed in order rather than re-derived.
  assert.equal(modelContextFromTable('gpt-3.5-turbo-1106')?.tokens, 16_383)
  assert.equal(modelContextFromTable('gpt-3.5-turbo')?.tokens, 4_095)
  // And `/gpt-4o/` (128k) before the exact `/^(gpt-4|…)$/` (8 191).
  assert.equal(modelContextFromTable('gpt-4o')?.tokens, 128_000)
  assert.equal(modelContextFromTable('gpt-4')?.tokens, 8_191)
})

test('every row says where its number came from and when it was read', () => {
  // A row whose source line is missing is a number nobody can check against the
  // page it was taken from, which is how a table like this rots.
  for (const row of MODEL_CONTEXT_TABLE) {
    assert.match(row.source, /Read 2\d{3}-\d{2}-\d{2}/, `${String(row.match)} has no read date`)
    assert.ok(row.tokens > 0, `${String(row.match)} has a nonsense window`)
  }
})

// -------------------------------------------------- reading a /models row

test('a context length is read from each spelling a real serve documents', () => {
  const cases: readonly { row: unknown, expect: number, who: string }[] = [
    { row: { id: 'x', max_model_len: 131_072 }, expect: 131_072, who: 'vLLM' },
    { row: { id: 'x', context_length: 163_840 }, expect: 163_840, who: 'OpenRouter' },
    { row: { id: 'x', top_provider: { context_length: 65_536 } }, expect: 65_536, who: 'OpenRouter top_provider' },
    { row: { id: 'x', max_context_length: 32_768 }, expect: 32_768, who: 'LM Studio' },
    { row: { id: 'x', meta: { n_ctx_train: 131_072 } }, expect: 131_072, who: 'llama.cpp' },
  ]
  for (const one of cases) {
    assert.equal(modelContextFromRow(one.row), one.expect, `${one.who}'s spelling was not read`)
  }
})

test('the ranked order decides when a row carries two spellings', () => {
  // vLLM's served window beats OpenRouter's model figure; the model's own
  // `context_length` beats one route's `top_provider.context_length`.
  assert.equal(modelContextFromRow({ id: 'x', max_model_len: 8_192, context_length: 131_072 }), 8_192)
  assert.equal(
    modelContextFromRow({ id: 'x', context_length: 131_072, top_provider: { context_length: 65_536 } }),
    131_072,
  )
})

test('a present-but-null field is not an answer of zero', () => {
  /*
   * The case a real serve produces: vLLM emits `max_model_len: null` on its
   * LoRA-adapter rows, and OpenRouter documents both its context fields as
   * `integer | null`. A reader that accepted a null would report a window of
   * zero, and every consumer dividing by it would call the conversation
   * infinitely full.
   */
  assert.equal(modelContextFromRow({ id: 'x', max_model_len: null }), undefined)
  assert.equal(modelContextFromRow({ id: 'x', max_model_len: null, context_length: 4_096 }), 4_096)
  assert.equal(modelContextFromRow({ id: 'x', context_length: 0 }), undefined)
  assert.equal(modelContextFromRow({ id: 'x', context_length: '131072' }), undefined)
  assert.equal(modelContextFromRow({ id: 'x', meta: null }), undefined)
})

test('a DeepSeek row is exactly the case no probe can answer', () => {
  // The documented response: `id`, `object`, `owned_by`, and nothing else
  // (api-docs.deepseek.com/api/list-models). This is why the table exists at
  // all — for this provider, a probe learns nothing and never will.
  assert.equal(
    modelContextFromRow({ id: 'deepseek-v4-flash', object: 'model', owned_by: 'deepseek' }),
    undefined,
  )
})

test('every candidate field names the provider that documents it', () => {
  for (const field of CONTEXT_LENGTH_FIELDS) {
    assert.ok(field.provider.length > 0, `${field.path.join('.')} names no provider`)
    assert.match(field.source, /Read 2\d{3}-\d{2}-\d{2}/, `${field.path.join('.')} has no read date`)
  }
})

// ------------------------------------------------------------- the clamp

test('a stored window above the model’s is clamped to the model’s', () => {
  const resolved = resolveWindow(settings({ contextWindow: 2_000_000 }), 32_768, {
    tokens: 1_000_000,
    source: 'table',
  })
  assert.equal(resolved.context, 1_000_000, 'the 2M window was not clamped')
  assert.equal(resolved.source, 'model')
  assert.equal(resolved.model, 'deepseek-v4-flash')
  assert.equal(resolved.modelContext, 1_000_000)
})

test('a stored window inside the model’s stands, and says so', () => {
  const resolved = resolveWindow(settings({ contextWindow: 65_536 }), 32_768, {
    tokens: 1_000_000,
    source: 'provider',
  })
  assert.equal(resolved.context, 65_536)
  assert.equal(resolved.source, 'settings')
  // Carried even though it did not decide anything: a surface that wants to say
  // "you are using 65K of a possible 1M" needs the other number.
  assert.equal(resolved.modelContext, 1_000_000)
})

test('unlocked lets the stored window stand above the model’s, and keeps both figures', () => {
  const resolved = resolveWindow(
    settings({ contextWindow: 2_000_000, contextUnlocked: true }),
    32_768,
    { tokens: 1_000_000, source: 'table' },
  )
  assert.equal(resolved.context, 2_000_000, 'unlocking did not lift the clamp')
  assert.equal(resolved.source, 'unlocked')
  assert.equal(resolved.modelContext, 1_000_000, 'the number the user chose to exceed is gone')
})

test('an unknown model changes nothing at all', () => {
  const resolved = resolveWindow(settings({ model: 'local/qwen3-8b', contextWindow: 2_000_000 }), 32_768)
  assert.equal(resolved.context, 2_000_000, 'a window was clamped against a model nothing knows')
  assert.equal(resolved.source, 'settings')
  assert.equal(resolved.modelContext, undefined)
})

test('no stored window is the host default, whatever the model allows', () => {
  const resolved = resolveWindow(settings(), 32_768, { tokens: 1_000_000, source: 'table' })
  assert.equal(resolved.context, 32_768)
  assert.equal(resolved.source, 'host')
  // Not raised to the model's window. The host default is a decision the
  // composition made; a model being able to take more is not a request to.
  assert.equal(resolved.modelContext, 1_000_000)
})

test('unlocked below the model’s window is not a separate answer', () => {
  // `unlocked` describes the one case where the flag *changed* something. With
  // a stored window the model would have accepted anyway, the flag is
  // irrelevant and saying "unclamped" would send a reader looking for a clamp
  // that was never going to apply.
  const resolved = resolveWindow(
    settings({ contextWindow: 8_192, contextUnlocked: true }),
    32_768,
    { tokens: 1_000_000, source: 'table' },
  )
  assert.equal(resolved.source, 'settings')
})

// ------------------------------------- the preset half of the same decision

test('a preset’s max_context_unlocked travels with its openai_max_context', () => {
  /*
   * Measured on the reported install: `[主预设] V19.5 狐神抚 · 毓忻.json` carries
   * `openai_max_context: 2000000` **and** `max_context_unlocked: true`. Only
   * the first half was ever applied, which is how a 2M window came to be in
   * force here — upstream's slider could not even have *reached* 2M without the
   * flag (its bound is the model's maximum until unlocked, openai.js:4967).
   */
  const patch = presetScalarPatch({
    prompts: [],
    openai_max_context: 2_000_000,
    max_context_unlocked: true,
  })
  assert.equal(patch['contextWindow'], 2_000_000)
  assert.equal(patch['contextUnlocked'], true)
})

test('a preset that asks to be clamped is applied as deliberately as one that asks not to be', () => {
  const patch = presetScalarPatch({ prompts: [], max_context_unlocked: false })
  assert.equal(patch['contextUnlocked'], false, 'a preset saying "clamp me" was ignored')
  // Garbage is skipped, the same rule every other field here follows.
  assert.equal(presetScalarPatch({ prompts: [], max_context_unlocked: 'yes' })['contextUnlocked'], undefined)
  // And a preset that says nothing leaves whatever is in force alone.
  assert.equal(Object.hasOwn(presetScalarPatch({ prompts: [] }), 'contextUnlocked'), false)
})

// ------------------------------------------- the clamp through the service

const CARD = JSON.stringify({
  spec: 'chara_card_v2',
  spec_version: '2.0',
  data: { name: 'Aria', description: 'An archivist.', first_mes: 'Hello.' },
})

/**
 * A service over a temp profile, with the settings the case is about.
 * @param t - the test context, for cleanup.
 * @param global - the global settings layer to start with.
 * @returns the handlers.
 */
async function service(
  t: TestContext,
  global: Partial<GenerationSettings>,
): Promise<Handlers> {
  const dir = await mkdtemp(join(tmpdir(), 'iris-model-context-'))
  // `maxRetries`, the tidy-up hardening `card-storage.test.ts` documents for
  // the Windows window 2b43efc found: a write can land a moment after the
  // last assertion, and a bare `rm` then fails the whole file with ENOTEMPTY.
  // Seen on full-suite runs after the atomic-write change of 2026-09-11,
  // which replaced one write syscall per save with a write and a rename.
  t.after(async () => { await rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }) })
  await mkdir(join(dir, 'characters'), { recursive: true })
  await writeFile(join(dir, 'characters', 'aria.json'), CARD, 'utf8')
  const library = new CharacterLibrary(join(dir, 'characters'), '/iris/avatar')
  const store = new SettingsStore(join(dir, 'settings.json'), {
    provider: 'default',
    model: 'deepseek-v4-flash',
  })
  await store.set(undefined, global)
  const stream: StreamFn = async function* (_options: GenerateOptions): AsyncIterable<StreamChunk> {
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  return new IrisAppService({
    stream,
    library,
    chats: materialisingChatStore(dir, library),
    settings: store,
    broadcast: (_event: IrisEvent) => {},
    userName: 'Traveller',
  }).handlers()
}

test('the reported conversation gets the model’s window, and the view says why', async (t) => {
  const handlers = await service(t, { contextWindow: 2_000_000 })
  const { view } = await handlers['chat.create']({ characterId: 'aria' })
  assert.equal(view.budget?.context, 1_000_000, 'the 2M window reached the open chat unclamped')
  assert.equal(view.budget?.source, 'model')
  assert.equal(view.budget?.model, 'deepseek-v4-flash')
  assert.equal(view.budget?.modelContext, 1_000_000)
  // The assembler divides by the same number the capsule does — the property
  // this being one resolver is for.
  const { itemization } = await handlers['prompt.itemize']({ chatId: view.chatId })
  assert.equal(itemization.budget.context, 1_000_000, 'the assembly and the readout disagree')
})

test('unlocking it through the settings puts the user’s number back, on both surfaces', async (t) => {
  const handlers = await service(t, { contextWindow: 2_000_000 })
  await handlers['settings.set']({ settings: { contextUnlocked: true } })
  const { view } = await handlers['chat.create']({ characterId: 'aria' })
  assert.equal(view.budget?.context, 2_000_000)
  assert.equal(view.budget?.source, 'unlocked')
  const { itemization } = await handlers['prompt.itemize']({ chatId: view.chatId })
  assert.equal(itemization.budget.context, 2_000_000, 'the assembly did not follow the unlock')
})

test('the stored window is left alone — the clamp is a reading, not a write', async (t) => {
  /*
   * Where this host deliberately parts from upstream. Upstream clamps at
   * settings time and writes the smaller number back
   * (`oai_settings.openai_max_context = Math.min(…)`), so the user's 2 000 000
   * is destroyed the moment they touch a 1M model and does not come back when
   * they unlock. Here the stored value survives, so unlocking restores exactly
   * what they asked for.
   */
  const handlers = await service(t, { contextWindow: 2_000_000 })
  await handlers['chat.create']({ characterId: 'aria' })
  const { settings: stored } = await handlers['settings.get']({})
  assert.equal(stored.contextWindow, 2_000_000, 'the clamp overwrote the user’s own number')
})

test('a recorded turn reports the window it actually assembled against', async (t) => {
  /*
   * The defect this pins: `#itemizationOf`'s window parameter was omitted at
   * the **record** site, so a real turn filed a budget of 32 768 — the host
   * composition's default — for an assembly that had just run at the resolved
   * window. The preview path passed it, which is why every reading taken
   * through the composer's card looked right.
   *
   * Reached through `prompt.itemize` **with a turn**, the only way to get a
   * record back (the handler returns one only when a turn is named). Without
   * the turn this test takes the preview path and passes against the bug.
   */
  const handlers = await service(t, { contextWindow: 2_000_000 })
  const { view } = await handlers['chat.create']({ characterId: 'aria' })
  await handlers['chat.send']({ chatId: view.chatId, kind: 'send', text: 'Hello.' })
  const opened = await handlers['chat.open']({ chatId: view.chatId })
  const measured = opened.view.measured
  assert.ok(measured !== undefined, 'the host recorded no itemization for a real turn')
  const { itemization } = await handlers['prompt.itemize']({
    chatId: view.chatId,
    turn: measured.turn,
  })
  assert.equal(itemization.preview, false, 'a preview came back, so this proves nothing')
  assert.equal(
    itemization.budget.context,
    1_000_000,
    'the recorded turn reports a window it did not assemble against',
  )
  // And the reading the capsule's gauge divides by is that same record — the
  // two must not be able to disagree about one turn.
  assert.equal(measured.tokens, itemization.tokens)
})

test('one ceiling bounds a typed window, a reported one, and the wire', async (t) => {
  /*
   * Three layers check this number and only the protocol could own it: the
   * settings store bounds what a person types, the probe bounds what an
   * endpoint reports about a model, and `connection.save`'s schema bounds what
   * crosses the wire. The third is not host-side, so a host constant could only
   * be *restated* there — and a wire validator restating a bound is how a
   * schema comes to refuse what the store would have accepted.
   *
   * The store side is asserted **behaviourally** rather than by reading its
   * table, which is private: what matters is that it accepts the ceiling and
   * refuses one past it, not how it spells the range.
   */
  const dir = await mkdtemp(join(tmpdir(), 'iris-ceiling-'))
  // `maxRetries`, the tidy-up hardening `card-storage.test.ts` documents for
  // the Windows window 2b43efc found: a write can land a moment after the
  // last assertion, and a bare `rm` then fails the whole file with ENOTEMPTY.
  // Seen on full-suite runs after the atomic-write change of 2026-09-11,
  // which replaced one write syscall per save with a write and a rename.
  t.after(async () => { await rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }) })
  const store = new SettingsStore(join(dir, 'settings.json'), {
    provider: 'default',
    model: 'deepseek-v4-flash',
  })
  await store.set(undefined, { contextWindow: MAX_CONTEXT_WINDOW })
  assert.equal(store.get().contextWindow, MAX_CONTEXT_WINDOW, 'the store refuses its own ceiling')
  await assert.rejects(
    () => store.set(undefined, { contextWindow: MAX_CONTEXT_WINDOW + 1 }),
    /contextWindow/,
    'the store accepted a window past the ceiling',
  )

  const schema = requestSchemas['connection.save']
  const at = (tokens: number): boolean =>
    schema.safeParse({
      provider: 'default',
      model: 'm',
      modelContexts: { m: { tokens, source: 'provider' } },
    }).success
  assert.equal(at(MAX_CONTEXT_WINDOW), true, 'the wire refuses the ceiling the store accepts')
  assert.equal(at(MAX_CONTEXT_WINDOW + 1), false, 'the wire accepts a window past the ceiling')

  // And the control the whole coupling is for: the number a person may type is
  // the number the settings drawer's slider will let them reach. Read out of
  // the source, because that bound is a literal in JSX and was 2 000 000 —
  // upstream's `unlocked_max` — while this ceiling said 4 000 000.
  const drawer = readFileSync(
    join(HERE, '..', '..', '..', 'apps', 'iris-web', 'src', 'app', 'MemoryContextPanel.tsx'),
    'utf8',
  )
  assert.match(
    drawer,
    /bounds=\{\{ min: 512, max: MAX_CONTEXT_WINDOW, step: 512 \}\}/,
    'the context-window slider does not read the shared ceiling',
  )
})

test('the reported install’s own preset resolves to an unclamped 2M, and the card says which', async (t) => {
  /*
   * The case the other service tests here do **not** cover, and the reason it
   * matters: they all start from a settings layer with no `contextUnlocked`, so
   * they only ever exercise the clamped branch. The reported profile's active
   * preset (`[主预设] V19.5 狐神抚 · 毓忻`) carries `openai_max_context: 2000000`
   * *and* `max_context_unlocked: true`, so once the flag travels the honest
   * answer is 2 000 000 — unclamped, on purpose, matching both the preset and
   * upstream-on-CUSTOM.
   *
   * The whole chain is exercised rather than asserted at one end: the preset's
   * two keys → `presetScalarPatch` → `settings.set` → the window on the view.
   * A test that wrote `contextUnlocked: true` directly would not notice the
   * patch dropping it.
   */
  const handlers = await service(t, {})
  const patch = presetScalarPatch({
    prompts: [],
    openai_max_context: 2_000_000,
    max_context_unlocked: true,
  })
  await handlers['settings.set']({ settings: patch })

  const { view } = await handlers['chat.create']({ characterId: 'aria' })
  assert.equal(view.budget?.context, 2_000_000, 'the preset asked to be unclamped and was clamped anyway')
  assert.equal(view.budget?.source, 'unlocked')
  // Both figures, because the surface prints both: what is in force, and the
  // model limit the user chose to exceed.
  assert.equal(view.budget?.modelContext, 1_000_000)
  assert.equal(view.budget?.model, 'deepseek-v4-flash')

  // And the clamp is one switch away — the thing the reporting user actually
  // wants, reachable without editing a preset file.
  await handlers['settings.set']({ settings: { contextUnlocked: false } })
  const clamped = await handlers['chat.open']({ chatId: view.chatId })
  assert.equal(clamped.view.budget?.context, 1_000_000)
  assert.equal(clamped.view.budget?.source, 'model')
})
