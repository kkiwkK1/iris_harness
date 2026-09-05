import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { IrisClient, WorldbookEntry } from '@iris/protocol'

import { createIrisStore } from '../src/client/store.ts'

/**
 * The editor's wiring to the host: the one write is a whole-book
 * `worldbook.replace` carrying the drafts, and "saved" afterwards means what
 * the host answered, not what the drafts wish.
 */

function wiEntry(uid: number, over: Partial<WorldbookEntry> = {}): WorldbookEntry {
  return {
    uid,
    name: `entry ${uid}`,
    enabled: true,
    strategy: {
      type: 'selective',
      keys: [`k${uid}`],
      keys_secondary: { logic: 'and_any', keys: [] },
      scan_depth: 'same_as_global',
    },
    position: { type: 'at_depth', role: 'system', depth: 4, order: 100 },
    content: `content ${uid}`,
    probability: 100,
    useProbability: true,
    recursion: { prevent_incoming: false, prevent_outgoing: false, delay_until: null },
    effect: { sticky: null, cooldown: null, delay: null },
    addMemo: true,
    group: '',
    groupOverride: false,
    groupWeight: 100,
    caseSensitive: null,
    matchWholeWords: null,
    outletName: '',
    automationId: '',
    useGroupScoring: null,
    ignoreBudget: false,
    triggers: [],
    characterFilter: { isExclude: false, names: [], tags: [] },
    matchPersonaDescription: false,
    matchCharacterDescription: false,
    matchCharacterPersonality: false,
    matchCharacterDepthPrompt: false,
    matchScenario: false,
    matchCreatorNotes: false,
    ...over,
  }
}

/** A client that serves one book and records what the editor sends. */
function wiClient(entries: WorldbookEntry[], afterSave: WorldbookEntry[]): {
  client: IrisClient
  calls: { method: string, params: Record<string, unknown> }[]
} {
  const calls: { method: string, params: Record<string, unknown> }[] = []
  const client: IrisClient = {
    connected: true,
    onConnectionChange: () => () => undefined,
    subscribe: () => () => undefined,
    async call(method, params) {
      calls.push({ method, params: params as Record<string, unknown> })
      if (method === 'chat.list') return { chats: [] } as never
      if (method === 'character.list') return { characters: [] } as never
      if (method === 'settings.get') return { settings: { provider: 'p', model: 'm' } } as never
      if (method === 'worldbook.get') return { entries } as never
      if (method === 'worldbook.replace') return { entries: afterSave } as never
      return {} as never
    },
  }
  return { client, calls }
}

test('saving sends the whole draft book through worldbook.replace, then reads saved from the answer', async () => {
  const saved = wiEntry(1, { probability: 40 })
  const { client, calls } = wiClient([wiEntry(1), wiEntry(2)], [saved, wiEntry(2)])
  const { store } = createIrisStore(client, { transport: 'rpc', origin: 'test' })

  await store.getState().openWiEditor('Book')
  assert.equal(store.getState().wiEditor?.book, 'Book')
  assert.equal(store.getState().wiEditor?.drafts.length, 2)

  store.getState().patchWiEntry(1, { probability: 40 })
  const edited = store.getState().wiEditor
  assert.ok(edited)
  assert.equal(edited.drafts[0]?.probability, 40)
  assert.equal(edited.drafts.length, 2)

  await store.getState().saveWiEditor()

  const replace = calls.find(row => row.method === 'worldbook.replace')
  assert.ok(replace, 'the save did not go through worldbook.replace')
  assert.equal(replace.params.name, 'Book')
  const sent = replace.params.entries as WorldbookEntry[]
  assert.equal(sent.length, 2, 'the save was not whole-book')
  assert.equal(sent[0]?.probability, 40)

  // Dirty is judged against the host's answer, not the drafts.
  const editor = store.getState().wiEditor
  assert.ok(editor)
  assert.equal(editor.drafts[0]?.probability, 40, 'the drafts did not take the saved answer')
  assert.equal(editor.baseline[0]?.probability, 40, 'the baseline did not take the saved answer')
})

test('discard returns the drafts to the baseline and the editor stays open', async () => {
  const { client } = wiClient([wiEntry(1)], [wiEntry(1)])
  const { store } = createIrisStore(client, { transport: 'rpc', origin: 'test' })

  await store.getState().openWiEditor('Book')
  store.getState().patchWiEntry(1, { name: 'changed' })
  store.getState().discardWiEdits()

  const editor = store.getState().wiEditor
  assert.ok(editor, 'discard closed the editor')
  assert.equal(editor.drafts[0]?.name, 'entry 1')
})

test('switching books replaces the held draft with the new book\u2019s entries', async () => {
  const { client } = wiClient([wiEntry(1)], [wiEntry(1)])
  const calls: { method: string, params: Record<string, unknown> }[] = []
  // A second book on the same client: the get answer is keyed by the ask.
  const client2: IrisClient = {
    ...client,
    async call(method, params) {
      calls.push({ method, params: params as Record<string, unknown> })
      const name = (params as { name?: string } | undefined)?.name
      if (method === 'worldbook.get') {
        return { entries: name === 'Other' ? [wiEntry(9, { name: 'nine' })] : [wiEntry(1)] } as never
      }
      return client.call(method, params)
    },
  }
  const { store } = createIrisStore(client2, { transport: 'rpc', origin: 'test' })

  await store.getState().openWiEditor('Book')
  await store.getState().openWiEditor('Other')
  const editor = store.getState().wiEditor
  assert.ok(editor)
  assert.equal(editor.book, 'Other')
  assert.equal(editor.drafts[0]?.name, 'nine')
})
