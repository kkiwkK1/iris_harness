import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

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

test('assembly order is the keys’ lexicographic order, not the order they arrived', async (t) => {
  const fixed = await fixture(t)

  // Registered deliberately out of alphabetical order.
  for (const key of ['zebra', 'alpha', 'middle']) {
    await fixed.handlers['script.setExtensionPrompt']({
      chatId: fixed.chatId, key, value: `text for ${key}`, position: 'at-depth', depth: 0,
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
    chatId: fixed.chatId, key: 'parked', value: 'not in the prompt', position: 'none', depth: 0,
  })
  await fixed.handlers['script.setExtensionPrompt']({
    chatId: fixed.chatId, key: 'live', value: 'in the prompt', position: 'at-depth', depth: 0,
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
    chatId: fixed.chatId, key: 'a', value: 'as the user', position: 'at-depth', depth: 2, role: 'user',
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
    chatId: fixed.chatId, key: 'a', value: 'text', position: 'at-depth', depth: 0,
  })

  const entry = await fixed.chats.open(fixed.chatId)
  const placement = injectedContributions(entry)[0]?.placement as { role?: string }
  assert.equal(placement.role, 'system')
})

test('an empty value removes the injection, which is how uninject works', async (t) => {
  const fixed = await fixture(t)

  await fixed.handlers['script.setExtensionPrompt']({
    chatId: fixed.chatId, key: 'yinqi-npc-messages', value: 'some text', position: 'at-depth', depth: 0,
  })
  // Exactly the call a corpus card makes to clear its own injection.
  await fixed.handlers['script.setExtensionPrompt']({
    chatId: fixed.chatId, key: 'yinqi-npc-messages', value: '', position: 'at-depth', depth: 0,
  })

  const entry = await fixed.chats.open(fixed.chatId)
  assert.deepEqual(injectedContributions(entry), [])
  assert.equal(entry.extensionPrompts.has('yinqi-npc-messages'), false)
})

test('the same key overwrites rather than accumulating', async (t) => {
  const fixed = await fixture(t)

  for (const value of ['first', 'second', 'third']) {
    await fixed.handlers['script.setExtensionPrompt']({
      chatId: fixed.chatId, key: 'same', value, position: 'at-depth', depth: 0,
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

test('should_scan is kept rather than flattened to false', async (t) => {
  const fixed = await fixture(t)

  await fixed.handlers['script.setExtensionPrompt']({
    chatId: fixed.chatId, key: 'scanned', value: 'mentions a keyword', position: 'at-depth', depth: 0, scan: true,
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
    chatId: fixed.chatId, key: 'a', value: 'text', position: 'at-depth', depth: 0,
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
    chatId: fixed.chatId, key: 'a', value: 'text', position: 'at-depth', depth: 0,
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

test('an injection with no run is kept, and the leak is reported', async (t) => {
  const fixed = await fixture(t)
  const reports: string[] = []
  // The fixture's service has no diagnostics buffer, so the report is read
  // through `onError` — the same channel, one layer earlier.
  const chats = fixed.chats
  const handlers = new IrisAppService({
    stream: async function* () { yield { type: 'finish', reason: { kind: 'stop' } } },
    library: new CharacterLibrary(join(fixed.dir, 'characters'), '/a'),
    chats,
    settings: new SettingsStore(join(fixed.dir, 'settings.json'), { provider: 'test', model: 'test-model' }),
    broadcast: () => {},
    userName: 'Traveller',
    onError: (error: Error) => { reports.push(error.message) },
  }).handlers()

  await handlers['script.setExtensionPrompt']({
    chatId: fixed.chatId, key: 'orphan', value: 'text', position: 'at-depth', depth: 0,
  })

  // **Kept, not dropped.** This is what every injection did before runs existed,
  // and refusing it would break a frame that has not shipped run ids yet.
  const entry = await chats.open(fixed.chatId)
  assert.equal(entry.extensionPrompts.get('orphan')?.value, 'text')

  // But an injection nothing can clear is a leak, so it is named once.
  assert.equal(reports.length, 1, `expected one report, got ${JSON.stringify(reports)}`)
  assert.match(reports[0] ?? '', /without a run id/u)

  // And a run ending cannot take it, which is the fact the report is about.
  const done = await handlers['script.runEnded']({ chatId: fixed.chatId, runId: 'chat:1' })
  assert.equal(done.cleared, 0)
  assert.equal(entry.extensionPrompts.has('orphan'), true)
})

test('clearing an injection needs no run, because the key is the handle', async (t) => {
  const fixed = await fixture(t)
  await fixed.handlers['script.setExtensionPrompt']({
    chatId: fixed.chatId, key: 'a', value: 'text', position: 'at-depth', depth: 0, runId: 'chat:1',
  })

  // Upstream's `uninject` is an empty value on the same key, and that has to keep
  // working without the caller knowing which run wrote it.
  await fixed.handlers['script.setExtensionPrompt']({
    chatId: fixed.chatId, key: 'a', value: '', position: 'at-depth', depth: 0,
  })

  const entry = await fixed.chats.open(fixed.chatId)
  assert.equal(entry.extensionPrompts.size, 0, 'an empty value no longer removes an injection')
})
