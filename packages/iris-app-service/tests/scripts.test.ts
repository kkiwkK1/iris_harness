import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { IrisEvent } from '@iris/protocol'
import type { StreamFn } from '@iris/turn'

import { ChatStore } from '../src/chats.ts'
import { CharacterLibrary } from '../src/library.ts'
import { ScriptPolicyStore } from '../src/scripts.ts'
import { IrisAppService, type Handlers } from '../src/service.ts'
import { SettingsStore } from '../src/settings.ts'

/**
 * The user's decisions about card scripts, and the fetch whitelist at the
 * boundary where it is actually enforced.
 */

/** A card carrying three scripts, one of them disabled by its author. */
const CARD = JSON.stringify({
  spec: 'chara_card_v3',
  spec_version: '3.0',
  data: {
    name: 'Aria',
    description: '', personality: '', scenario: '',
    first_mes: 'Hello.', mes_example: '', creator_notes: '',
    system_prompt: '', post_history_instructions: '', alternate_greetings: [],
    tags: [], creator: '', character_version: '1',
    extensions: {
      tavern_helper: {
        scripts: [
          { id: 'core', name: 'ERA core', type: 'script', enabled: true, content: 'var a = 1'.repeat(40) },
          { id: 'exp', name: 'ERA exp', type: 'script', enabled: true, content: 'let b = 2' },
          { id: 'wip', name: 'ERA wip', type: 'script', enabled: false, content: 'noop()' },
        ],
        variables: {},
      },
    },
  },
})

const NOTHING: StreamFn = async function* (_options: GenerateOptions): AsyncIterable<StreamChunk> {
  yield { type: 'finish', reason: { kind: 'stop' } }
}

/** A booted service with a card library and a policy store. */
async function fixture(t: TestContext, fetchRemote?: NonNullable<Parameters<typeof makeService>[1]>) {
  const dir = await mkdtemp(join(tmpdir(), 'iris-scripts-'))
  t.after(async () => { await rm(dir, { recursive: true, force: true }) })
  await mkdir(join(dir, 'characters'), { recursive: true })
  await writeFile(join(dir, 'characters', 'aria.json'), CARD, 'utf8')
  return makeService(dir, fetchRemote)
}

function makeService(
  dir: string,
  fetchRemote?: (url: string) => Promise<{ ok: boolean, status: number, text: () => Promise<string>, headers: { get: (name: string) => string | null } }>,
): { handlers: Handlers, policyPath: string } {
  const library = new CharacterLibrary(join(dir, 'characters'), '/iris/avatar')
  const policyPath = join(dir, 'script-policy.json')
  const service = new IrisAppService({
    stream: NOTHING,
    library,
    chats: new ChatStore(join(dir, 'chats'), library),
    settings: new SettingsStore(join(dir, 'settings.json'), { provider: 'test', model: 'test-model' }),
    scripts: new ScriptPolicyStore(policyPath),
    broadcast: (_event: IrisEvent) => {},
    userName: 'Traveller',
    ...fetchRemote === undefined ? {} : { fetchRemote },
  })
  return { handlers: service.handlers(), policyPath }
}

test('a script list shows what the card contains, disabled scripts included', async (t) => {
  // A list that hid them would leave the user unable to see what is in the card
  // they just imported.
  const { handlers } = await fixture(t)

  const { scripts, documentGranted } = await handlers['script.list']({ characterId: 'aria' })

  assert.deepEqual(scripts.map(row => row.id), ['core', 'exp', 'wip'])
  assert.equal(documentGranted, false, 'no card holds the document by default')
  assert.equal(scripts[0]?.bytes, 360, 'the size is reported so a list can say what it will run')
})

test('the two switches are reported separately', async (t) => {
  // "Why is this off" is only answerable if the card's choice and the user's
  // are distinguishable. A single boolean cannot say which one turned it off.
  const { handlers } = await fixture(t)

  const before = await handlers['script.list']({ characterId: 'aria' })
  assert.deepEqual(before.scripts.map(row => [row.enabledByCard, row.enabled]), [[true, true], [true, true], [false, false]])

  const after = await handlers['script.setEnabled']({ characterId: 'aria', scriptId: 'core', enabled: false })

  const core = after.scripts.find(row => row.id === 'core')
  assert.equal(core?.enabledByCard, true, "the card's own answer is unchanged")
  assert.equal(core?.enabled, false, "the user's answer wins")
})

test("the user can switch on a script the card's author disabled", async (t) => {
  // The override is a decision, not a veto in one direction only.
  const { handlers } = await fixture(t)

  const after = await handlers['script.setEnabled']({ characterId: 'aria', scriptId: 'wip', enabled: true })
  const wip = after.scripts.find(row => row.id === 'wip')

  assert.equal(wip?.enabledByCard, false)
  assert.equal(wip?.enabled, true)
})

test('the user override survives a fresh store reading the same file', async (t) => {
  // The point of persisting it: a re-import must not revive a script the user
  // turned off, and that only holds if the decision outlives the process.
  const dir = await mkdtemp(join(tmpdir(), 'iris-scripts-'))
  t.after(async () => { await rm(dir, { recursive: true, force: true }) })
  await mkdir(join(dir, 'characters'), { recursive: true })
  await writeFile(join(dir, 'characters', 'aria.json'), CARD, 'utf8')

  const first = makeService(dir)
  await first.handlers['script.setEnabled']({ characterId: 'aria', scriptId: 'core', enabled: false })

  const second = makeService(dir)
  const { scripts } = await second.handlers['script.list']({ characterId: 'aria' })

  assert.equal(scripts.find(row => row.id === 'core')?.enabled, false)
})

test('an unknown script id is refused rather than stored', async (t) => {
  // A policy file accumulating ids from typos and stale cards is one nobody can
  // audit, and this file is a permission record.
  const { handlers, policyPath } = await fixture(t)

  await assert.rejects(
    handlers['script.setEnabled']({ characterId: 'aria', scriptId: 'nope', enabled: false }),
    /no script "nope"/,
  )
  await assert.rejects(readFile(policyPath, 'utf8'), 'nothing was written')
})

// ── the document grant ──────────────────────────────────────────────────────

test('the document grant is denied by default and survives a restart once given', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'iris-scripts-'))
  t.after(async () => { await rm(dir, { recursive: true, force: true }) })
  await mkdir(join(dir, 'characters'), { recursive: true })
  await writeFile(join(dir, 'characters', 'aria.json'), CARD, 'utf8')

  const first = makeService(dir)
  assert.equal((await first.handlers['script.list']({ characterId: 'aria' })).documentGranted, false)

  const granted = await first.handlers['script.setDocumentGrant']({ characterId: 'aria', granted: true })
  assert.equal(granted.documentGranted, true)

  const second = makeService(dir)
  assert.equal((await second.handlers['script.list']({ characterId: 'aria' })).documentGranted, true)
})

test('a revoked grant is stored as absent, not as false', async (t) => {
  // Absent and denied have to be the same state. If a revoked grant read
  // differently from one never given, something downstream would eventually
  // treat the two differently — and only one of those readings is safe.
  const { handlers, policyPath } = await fixture(t)

  await handlers['script.setDocumentGrant']({ characterId: 'aria', granted: true })
  await handlers['script.setDocumentGrant']({ characterId: 'aria', granted: false })

  const stored: unknown = JSON.parse(await readFile(policyPath, 'utf8'))
  const record = (stored as { characters: Record<string, Record<string, unknown>> }).characters['aria'] ?? {}

  assert.equal('documentGranted' in record, false, 'the key is gone, not set to false')
  assert.equal((await handlers['script.list']({ characterId: 'aria' })).documentGranted, false)
})

test('a grant cannot be stored against a character that is not there', async (t) => {
  // A permission outliving its subject is a permission nobody can find to
  // revoke.
  const { handlers } = await fixture(t)

  await assert.rejects(handlers['script.setDocumentGrant']({ characterId: 'ghost', granted: true }))
})

// ── the fetch whitelist, at the boundary ────────────────────────────────────

/** A fetcher that records what it was asked for. */
function recordingFetch(body = 'export const x = 1') {
  const asked: string[] = []
  return {
    asked,
    fetch: async (url: string) => {
      asked.push(url)
      return { ok: true, status: 200, text: async () => body, headers: { get: () => 'application/javascript' } }
    },
  }
}

test('a whitelisted source is fetched and returned', async (t) => {
  const recorder = recordingFetch()
  const { handlers } = await fixture(t, recorder.fetch)

  const result = await handlers['script.fetch']({
    url: 'https://testingcf.jsdelivr.net/gh/MagicalAstrogy/MagVarUpdate@master/artifact/bundle.js',
  })

  assert.equal(result.content, 'export const x = 1')
  assert.equal(result.contentType, 'application/javascript')
  assert.equal(recorder.asked.length, 1)
})

test('an unlisted host is refused before any request is made', async (t) => {
  // The order matters: refusing after the fetch would still have told the host
  // that this user is running this card.
  const recorder = recordingFetch()
  const { handlers } = await fixture(t, recorder.fetch)

  await assert.rejects(handlers['script.fetch']({ url: 'https://unpkg.com/thing' }), /unpkg\.com/)
  assert.deepEqual(recorder.asked, [], 'nothing was requested')
})

test('http is refused and not silently upgraded', async (t) => {
  const recorder = recordingFetch()
  const { handlers } = await fixture(t, recorder.fetch)

  await assert.rejects(handlers['script.fetch']({ url: 'http://cdn.jsdelivr.net/x.js' }), /only https/)
  assert.deepEqual(recorder.asked, [])
})

test("a source's own failure is reported as the source's, not as a refusal", async (t) => {
  // A 404 from an allowed CDN and a blocked host are different problems, and a
  // card author debugging one must not be shown the other.
  const { handlers } = await fixture(t, async () => ({
    ok: false, status: 404, text: async () => '', headers: { get: () => null },
  }))

  await assert.rejects(
    handlers['script.fetch']({ url: 'https://cdn.jsdelivr.net/gh/o/r@1/missing.js' }),
    /cdn\.jsdelivr\.net answered 404/,
  )
})
