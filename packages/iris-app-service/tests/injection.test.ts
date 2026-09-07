import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

import { renderSystem, type Contribution } from '@iris/pipeline'
import type { StreamFn } from '@iris/turn'

import { ChatStore } from '../src/chats.ts'
import { DiagnosticBuffer } from '../src/diagnostics.ts'
import { CharacterLibrary } from '../src/library.ts'
import { injectedContributions, IrisAppService, type Handlers } from '../src/service.ts'
import { SettingsStore } from '../src/settings.ts'

/**
 * A card script's prompt injections, built to upstream's whole signature.
 *
 * `injectPrompts` is a thin wrapper over `setExtensionPrompt` — the handle it
 * returns is the key, and `uninject()` is `_.unset(extension_prompts, id)`. So
 * the host arm is the primitive, and the wrapper composes in the façade. What
 * has to be right here is the primitive's full shape: `id / position / depth /
 * role / content / should_scan`, and the two assembly rules that go with it.
 *
 * These are written from upstream's mechanism rather than from what any card
 * was observed doing. A corpus count of zero means "not yet met", never "not
 * needed".
 */

const CARD = JSON.stringify({
  spec: 'chara_card_v2', spec_version: '2.0',
  data: {
    name: 'Aria', description: '', personality: '', scenario: '',
    first_mes: 'Hello.', mes_example: '', creator_notes: '', system_prompt: '',
    post_history_instructions: '', alternate_greetings: [], tags: [],
    creator: '', character_version: '1', extensions: {},
  },
})

/** A host with one open chat. */
async function fixture(
  t: TestContext,
): Promise<{ handlers: Handlers, chats: ChatStore, chatId: string, dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'iris-inject-'))
  t.after(async () => { await rm(dir, { recursive: true, force: true }) })
  await mkdir(join(dir, 'characters'), { recursive: true })
  await writeFile(join(dir, 'characters', 'aria.json'), CARD, 'utf8')

  const library = new CharacterLibrary(join(dir, 'characters'), '/iris/avatar')
  const chats = new ChatStore(join(dir, 'chats'), library)
  const stream: StreamFn = async function* () { yield { type: 'finish', reason: { kind: 'stop' } } }
  const handlers = new IrisAppService({
    stream, library, chats,
    settings: new SettingsStore(join(dir, 'settings.json'), { provider: 'test', model: 'test-model' }),
    broadcast: () => {},
    userName: 'Traveller',
  }).handlers()

  const created = await handlers['chat.create']({ characterId: 'aria' })
  return { handlers, chats, chatId: created.view.chatId, dir }
}

/** One run for every injection in this file: the subject here is not run identity. */
const RUN = 'chat:1'

/**
 * The same handlers, with reports collected.
 *
 * The file's own fixture has no diagnostics buffer, so a report is read one
 * layer earlier through `onError` — the same sentence, before it is recorded.
 * @param fixed - the fixture to reuse the stores of.
 * @param into - collects each reported message.
 * @returns handlers over the same chat.
 */
function reporting(
  fixed: { chats: ChatStore, dir: string },
  into: string[],
): Handlers {
  return new IrisAppService({
    stream: async function* () { yield { type: 'finish', reason: { kind: 'stop' } } },
    library: new CharacterLibrary(join(fixed.dir, 'characters'), '/a'),
    chats: fixed.chats,
    settings: new SettingsStore(join(fixed.dir, 'settings.json'), { provider: 'test', model: 'test-model' }),
    broadcast: () => {},
    userName: 'Traveller',
    onError: (error: Error) => { into.push(error.message) },
  }).handlers()
}

test('assembly order is the keys’ lexicographic order, not the order they arrived', async (t) => {
  const fixed = await fixture(t)

  // Registered deliberately out of alphabetical order.
  for (const key of ['zebra', 'alpha', 'middle']) {
    await fixed.handlers['script.setExtensionPrompt']({
      chatId: fixed.chatId, key, value: `text for ${key}`, position: 'at-depth', depth: 0, runId: RUN,
    })
  }

  const entry = await fixed.chats.open(fixed.chatId)
  const ids = injectedContributions(entry).map(contribution => contribution.id)

  // Upstream walks `Object.keys(extension_prompts).sort()`, so the
  // concatenation order inside one group is the key order. Iterating the Map
  // gave insertion order, which agrees only when a card injects alphabetically
  // — and nothing would report the difference, because both orders produce a
  // well-formed prompt. This is why upstream names its own keys `1_memory`,
  // `2_floating_prompt`, `3_vectors`: the digits are a sorting device.
  assert.deepEqual(ids, ['script.alpha', 'script.middle', 'script.zebra'])
})

test('an injection at position none is held but never assembled', async (t) => {
  const fixed = await fixture(t)

  await fixed.handlers['script.setExtensionPrompt']({
    chatId: fixed.chatId, key: 'parked', value: 'not in the prompt', position: 'none', depth: 0, runId: RUN,
  })
  await fixed.handlers['script.setExtensionPrompt']({
    chatId: fixed.chatId, key: 'live', value: 'in the prompt', position: 'at-depth', depth: 0, runId: RUN,
  })

  const entry = await fixed.chats.open(fixed.chatId)

  // Upstream's `NONE: -1` is queried by no call site, so the injection exists
  // to be overwritten or removed by key and contributes nothing. Three states,
  // not two: assembled, registered-but-silent, and absent.
  assert.deepEqual(injectedContributions(entry).map(item => item.id), ['script.live'])
  assert.equal(entry.extensionPrompts.has('parked'), true, 'a parked injection was dropped instead of held')
})

test('a role rides through to the depth placement', async (t) => {
  const fixed = await fixture(t)

  await fixed.handlers['script.setExtensionPrompt']({
    chatId: fixed.chatId, key: 'a', value: 'as the user', position: 'at-depth', depth: 2, runId: RUN, role: 'user',
  })

  const entry = await fixed.chats.open(fixed.chatId)
  const placement = injectedContributions(entry)[0]?.placement as { kind: string, role?: string, depth?: number }

  assert.equal(placement.kind, 'depth')
  assert.equal(placement.role, 'user')
  assert.equal(placement.depth, 2)
})

test('no role means system, which is what the depth placement always assumed', async (t) => {
  const fixed = await fixture(t)
  await fixed.handlers['script.setExtensionPrompt']({
    chatId: fixed.chatId, key: 'a', value: 'text', position: 'at-depth', depth: 0, runId: RUN,
  })

  const entry = await fixed.chats.open(fixed.chatId)
  const placement = injectedContributions(entry)[0]?.placement as { role?: string }
  assert.equal(placement.role, 'system')
})

test('an empty value removes the injection, which is how uninject works', async (t) => {
  const fixed = await fixture(t)

  await fixed.handlers['script.setExtensionPrompt']({
    chatId: fixed.chatId, key: 'yinqi-npc-messages', value: 'some text', position: 'at-depth', depth: 0, runId: RUN,
  })
  // Exactly the call a corpus card makes to clear its own injection.
  await fixed.handlers['script.setExtensionPrompt']({
    chatId: fixed.chatId, key: 'yinqi-npc-messages', value: '', position: 'at-depth', depth: 0, runId: RUN,
  })

  const entry = await fixed.chats.open(fixed.chatId)
  assert.deepEqual(injectedContributions(entry), [])
  assert.equal(entry.extensionPrompts.has('yinqi-npc-messages'), false)
})

test('the same key overwrites rather than accumulating', async (t) => {
  const fixed = await fixture(t)

  for (const value of ['first', 'second', 'third']) {
    await fixed.handlers['script.setExtensionPrompt']({
      chatId: fixed.chatId, key: 'same', value, position: 'at-depth', depth: 0, runId: RUN,
    })
  }

  // Upstream assigns the whole record per key. Accumulating would grow the
  // prompt without bound across a long chat, and the symptom — the model losing
  // the early conversation — looks nothing like its cause.
  const entry = await fixed.chats.open(fixed.chatId)
  const contributions = injectedContributions(entry)
  assert.equal(contributions.length, 1)
  assert.equal(contributions[0]?.text, 'third')
})

test('an injection’s macros are expanded at assembly, not sent as braces', async (t) => {
  const fixed = await fixture(t)

  // 不要被神隐挑战's engine injects a prompt carrying `{{user}}`; the raw
  // braces reached the provider and the host's own residual-macro pass graded
  // that a fault — "Iris implements these, so the expansion did not reach that
  // text". Assembly is where the other contributions are expanded, so it is
  // where this one is expanded too: against the chat's expander, which knows
  // the speaker names, and at call time, so a rename or a variable write is
  // honoured by the next generation without the stored value changing.
  await fixed.handlers['script.setExtensionPrompt']({
    chatId: fixed.chatId, key: 'engine', value: '{{char}} addresses {{user}} directly.',
    position: 'at-depth', depth: 0, runId: RUN,
  })

  const entry = await fixed.chats.open(fixed.chatId)
  const [contribution] = injectedContributions(entry)
  assert.equal(contribution?.text, 'Aria addresses Traveller directly.')
  assert.equal(entry.extensionPrompts.get('engine')?.value, '{{char}} addresses {{user}} directly.',
    'assembly expanded the stored value instead of leaving it raw')
})

test('should_scan is kept rather than flattened to false', async (t) => {
  const fixed = await fixture(t)

  await fixed.handlers['script.setExtensionPrompt']({
    chatId: fixed.chatId, key: 'scanned', value: 'mentions a keyword', position: 'at-depth', depth: 0, runId: RUN, scan: true,
  })

  // The scan pass does not honour this yet. Storing it is the difference
  // between a gap someone can find and a request silently answered with its
  // opposite — the request survives, and the day the scan pass reads it, the
  // cards that asked for it are already asking correctly.
  const entry = await fixed.chats.open(fixed.chatId)
  assert.equal(entry.extensionPrompts.get('scanned')?.scan, true)
})

test('injections do not survive a reload, matching upstream', async (t) => {
  const fixed = await fixture(t)
  await fixed.handlers['script.setExtensionPrompt']({
    chatId: fixed.chatId, key: 'a', value: 'text', position: 'at-depth', depth: 0, runId: RUN,
  })

  // Upstream keeps `extension_prompts` in a module-level object with no
  // serialisation anywhere, and `clearChat()` empties it. An injection belongs
  // to a running script; one that is not running should not still shape the
  // prompt. Verified through a second store over the same directory, which is
  // what a restart looks like.
  const entry = await fixed.chats.open(fixed.chatId)
  assert.equal(injectedContributions(entry).length, 1)

  const reopened = new ChatStore(
    join(fixed.dir, 'chats'),
    new CharacterLibrary(join(fixed.dir, 'characters'), '/iris/avatar'),
  )
  const reloaded = await reopened.open(fixed.chatId)
  assert.deepEqual(injectedContributions(reloaded), [])
})

test('re-opening a chat that still holds injections says so', async (t) => {
  const fixed = await fixture(t)
  const diagnostics = new DiagnosticBuffer()
  // A second service over the same stores, so the report has somewhere to land.
  const watched = new IrisAppService({
    stream: async function* () { yield { type: 'finish', reason: { kind: 'stop' } } },
    library: new CharacterLibrary(join(fixed.dir, 'characters'), '/iris/avatar'),
    chats: fixed.chats,
    settings: new SettingsStore(join(fixed.dir, 'settings.json'), { provider: 'test', model: 'test-model' }),
    broadcast: () => {},
    userName: 'Traveller',
    diagnostics,
  }).handlers()

  await watched['script.setExtensionPrompt']({
    chatId: fixed.chatId, key: 'a', value: 'text', position: 'at-depth', depth: 0, runId: RUN,
  })
  await watched['chat.open']({ chatId: fixed.chatId })

  // SillyTavern's `clearChat()` empties its single global `extension_prompts`
  // on every chat open; ours are per conversation and survive. The divergence
  // is deliberate — a chat's injections belong to that chat — but a card
  // written against upstream assumes a clean slate here, and stale injected
  // text looks exactly like text the card meant to put there. So the report is
  // the point: this is the silence family, whose fix is a sentence at the
  // moment it happens.
  const page = await watched['debug.reports']({})
  const injectionReports = page.reports.filter(report => /still live on this chat/u.test(report.message))
  assert.equal(injectionReports.length, 1, `saw ${JSON.stringify(page.reports.map(r => r.message))}`)
  assert.equal(injectionReports[0]?.kind, 'script')
  assert.equal(injectionReports[0]?.chatId, fixed.chatId)
  assert.match(injectionReports[0]?.message ?? '', /^1 script injection\(s\)/u)
})

test('a chat with no live injections re-opens quietly', async (t) => {
  const fixed = await fixture(t)
  const diagnostics = new DiagnosticBuffer()
  const watched = new IrisAppService({
    stream: async function* () { yield { type: 'finish', reason: { kind: 'stop' } } },
    library: new CharacterLibrary(join(fixed.dir, 'characters'), '/iris/avatar'),
    chats: fixed.chats,
    settings: new SettingsStore(join(fixed.dir, 'settings.json'), { provider: 'test', model: 'test-model' }),
    broadcast: () => {},
    userName: 'Traveller',
    diagnostics,
  }).handlers()

  await watched['chat.open']({ chatId: fixed.chatId })
  await watched['chat.open']({ chatId: fixed.chatId })

  // The other half of the discipline: an instrument that also fires on the
  // ordinary path teaches its reader to ignore it.
  const page = await watched['debug.reports']({})
  assert.deepEqual(page.reports.filter(report => /still live/u.test(report.message)), [])
})

test('ending a run clears its own injections and leaves another run alone', async (t) => {
  const fixed = await fixture(t)

  // **Two runs on one chat is the case upstream cannot have.** It empties a
  // single global table on every chat open, which is safe when exactly one chat
  // is active; here a second page may hold the same conversation open, and
  // clearing by chat would pull its text out from under it.
  await fixed.handlers['script.setExtensionPrompt']({
    chatId: fixed.chatId, key: 'a', value: 'from page one', position: 'at-depth', depth: 0, runId: 'chat:1',
  })
  await fixed.handlers['script.setExtensionPrompt']({
    chatId: fixed.chatId, key: 'b', value: 'from page two', position: 'at-depth', depth: 0, runId: 'chat:2',
  })

  const done = await fixed.handlers['script.runEnded']({ chatId: fixed.chatId, runId: 'chat:1' })

  assert.equal(done.cleared, 1)
  const entry = await fixed.chats.open(fixed.chatId)
  assert.deepEqual([...entry.extensionPrompts.keys()], ['b'], 'the surviving run lost its injection')
})

test('clearing an injection needs no run, because the key is the handle', async (t) => {
  const fixed = await fixture(t)
  await fixed.handlers['script.setExtensionPrompt']({
    chatId: fixed.chatId, key: 'a', value: 'text', position: 'at-depth', depth: 0, runId: 'chat:1',
  })

  // Upstream's `uninject` is an empty value on the same key, and that has to keep
  // working without the caller knowing which run wrote it.
  await fixed.handlers['script.setExtensionPrompt']({
    chatId: fixed.chatId, key: 'a', value: '', position: 'at-depth', depth: 0, runId: RUN,
  })

  const entry = await fixed.chats.open(fixed.chatId)
  assert.equal(entry.extensionPrompts.size, 0, 'an empty value no longer removes an injection')
})

test('a run that ended with nothing left still says so', async (t) => {
  const fixed = await fixture(t)
  const reports: string[] = []
  const handlers = reporting(fixed, reports)

  await handlers['script.setExtensionPrompt']({
    chatId: fixed.chatId, key: 'a', value: 'text', position: 'at-depth', depth: 0, runId: 'chat:1',
  })
  await handlers['script.runEnded']({ chatId: fixed.chatId, runId: 'chat:1' })
  reports.length = 0

  // **A second end for the same run clears nothing, and must not be silent.**
  // The first version of this spoke only when it cleared, so two full cycles of
  // correctly paired ends produced no line at all — indistinguishable from a
  // mechanism that had stopped.
  const done = await handlers['script.runEnded']({ chatId: fixed.chatId, runId: 'chat:1' })

  assert.equal(done.cleared, 0)
  assert.equal(reports.length, 1, `expected one line, got ${JSON.stringify(reports)}`)
  assert.match(reports[0] ?? '', /nothing left to clear/u)
})

test('a run this chat never saw is named, without reading its shape', async (t) => {
  const fixed = await fixture(t)
  const reports: string[] = []
  const handlers = reporting(fixed, reports)

  await handlers['script.setExtensionPrompt']({
    chatId: fixed.chatId, key: 'a', value: 'text', position: 'at-depth', depth: 0, runId: 'chat:1',
  })
  reports.length = 0

  // A mismatched pair takes this shape: the run id is real, but not on this
  // chat. Caught by never having *seen* the name — not by parsing `chatId:n`,
  // which would give the host an opinion about how the shell counts runs.
  await handlers['script.runEnded']({ chatId: fixed.chatId, runId: 'someone-elses-chat:7' })

  assert.equal(reports.length, 1)
  assert.match(reports[0] ?? '', /no injection on this chat ever named it/u)

  // And it says both possibilities, because the host cannot tell them apart: a
  // run that injected nothing was never announced either.
  assert.match(reports[0] ?? '', /injected nothing, or this chat and run do not belong together/u)

  // The real run is untouched by a stranger's end.
  const entry = await fixed.chats.open(fixed.chatId)
  assert.equal(entry.extensionPrompts.has('a'), true, 'a mismatched end cleared a live injection')
})

/**
 * A preset's system sections, ten apart, the way `resolvePreset` numbers them.
 * @param mainOrder - where `main` sits in the list.
 * @returns three sections, `main` in the middle.
 */
function presetSections(mainOrder = 20): Contribution[] {
  return [
    { id: 'nsfw', placement: { kind: 'system', order: mainOrder - 10 }, text: 'FIRST-SECTION' },
    { id: 'main', placement: { kind: 'system', order: mainOrder }, text: 'MAIN-PROMPT' },
    { id: 'jailbreak', placement: { kind: 'system', order: mainOrder + 10 }, text: 'LAST-SECTION' },
  ]
}

test('a before/after injection is anchored to the preset’s main prompt, not to the end of the block', async (t) => {
  const fixed = await fixture(t)

  await fixed.handlers['script.setExtensionPrompt']({
    chatId: fixed.chatId, key: 'ahead', value: 'AHEAD-OF-MAIN', position: 'before', depth: 0, runId: RUN,
  })
  await fixed.handlers['script.setExtensionPrompt']({
    chatId: fixed.chatId, key: 'behind', value: 'BEHIND-MAIN', position: 'after', depth: 0, runId: RUN,
  })

  const entry = await fixed.chats.open(fixed.chatId)
  const preset = presetSections()
  const injected = injectedContributions(entry, preset)

  // Upstream's `before` is `getPromptPosition(BEFORE_PROMPT) === 'start'`
  // (`openai.js:1131-1140`), and the only consumer of that word is
  // `injectToMain` → `chatCompletion.insert(message, 'main', 'start')`, which
  // unshifts the message into the **main prompt's own collection**
  // (`openai.js:1256-1300`, `:3940-3960`). So the text sits immediately before
  // the main prompt and `after` immediately behind it — both near the TOP of a
  // default order, not after every preset section.
  assert.deepEqual(
    injected.map(item => [item.id, (item.placement as { order: number }).order]),
    [['script.ahead', 19], ['script.behind', 21]],
  )

  // The claim in the form a reader can check: the rendered system prompt.
  assert.equal(
    renderSystem([...preset, ...injected]),
    ['FIRST-SECTION', 'AHEAD-OF-MAIN', 'MAIN-PROMPT', 'BEHIND-MAIN', 'LAST-SECTION'].join('\n\n'),
  )
})

test('a main prompt the preset moved into the conversation takes its injections with it', async (t) => {
  const fixed = await fixture(t)

  await fixed.handlers['script.setExtensionPrompt']({
    chatId: fixed.chatId, key: 'ahead', value: 'AHEAD-OF-MAIN', position: 'before', depth: 0, runId: RUN,
  })

  // `injection_position: 'absolute'` on `main` — the `else` branch of
  // `injectToMain`, which copies main's depth, role and order onto the
  // injection rather than leaving it in the system block on its own.
  const entry = await fixed.chats.open(fixed.chatId)
  const preset: Contribution[] = [
    { id: 'main', placement: { kind: 'depth', depth: 4, role: 'user', order: 7 }, text: 'MAIN-PROMPT' },
  ]

  assert.deepEqual(injectedContributions(entry, preset)[0]?.placement, {
    kind: 'depth', depth: 4, role: 'user', order: 6,
  })
})

test('with no main prompt the injection keeps the end of the system block rather than vanishing', async (t) => {
  const fixed = await fixture(t)

  await fixed.handlers['script.setExtensionPrompt']({
    chatId: fixed.chatId, key: 'ahead', value: 'AHEAD-OF-MAIN', position: 'before', depth: 0, runId: RUN,
  })
  await fixed.handlers['script.setExtensionPrompt']({
    chatId: fixed.chatId, key: 'behind', value: 'BEHIND-MAIN', position: 'after', depth: 0, runId: RUN,
  })

  // Upstream loses both of these: `injectToMain` finds no main message and no
  // absolute main prompt, and returns. **A documented divergence** — deleting a
  // card's text is the one outcome the prompt panel cannot explain, so the old
  // ends of the system block are kept for a preset that has no main section.
  const entry = await fixed.chats.open(fixed.chatId)
  assert.deepEqual(
    injectedContributions(entry, [
      { id: 'nsfw', placement: { kind: 'system', order: 10 }, text: 'FIRST-SECTION' },
    ]).map(item => (item.placement as { order: number }).order),
    [850, 950],
  )
})
