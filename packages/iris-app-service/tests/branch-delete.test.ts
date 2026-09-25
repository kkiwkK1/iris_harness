/**
 * `chat.delete` and `chat.rename` on a lineage, end to end through the
 * service: branches made with `chat.branch`, the delete carried out on the
 * files, and the result read back through `chat.tree` and `chat.list`.
 *
 * What the pure plan cannot show and these do: the re-attached child's
 * header on disk (`iris.parentChatId`, `iris.branchAt`, upstream's
 * `main_chat`), that its floors are byte-identical and its `updatedAt`
 * untouched, that the tree drawn afterwards has no lane naming a parent that
 * is gone, and that a cascade removes exactly the subtree.
 */

import assert from 'node:assert/strict'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { ChatTreeView } from '@iris/protocol'
import type { StreamFn } from '@iris/turn'

import type { Handlers } from '../src/service.ts'
import { createTestService } from './support/service.ts'

const CARD = JSON.stringify({
  spec: 'chara_card_v2',
  spec_version: '2.0',
  data: {
    name: 'Aria', description: '', personality: '', scenario: '',
    first_mes: 'Hello.', mes_example: '', creator_notes: '',
    system_prompt: '', post_history_instructions: '', alternate_greetings: [],
    tags: [], creator: '', character_version: '1', extensions: {},
  },
})

interface Fixture {
  dir: string
  handlers: Handlers
  /** Send a line and wait for the reply to settle. */
  say: (chatId: string, text: string) => Promise<void>
  lines: (chatId: string) => Promise<string[]>
  header: (chatId: string) => Promise<{ iris: Record<string, unknown>, chat_metadata: Record<string, unknown> }>
}

async function fixture(t: TestContext): Promise<Fixture> {
  let replies = 0
  let ends = 0
  const stream: StreamFn = async function* (_options: GenerateOptions): AsyncIterable<StreamChunk> {
    replies += 1
    const text = `Reply ${String(replies)}.`
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  const { handlers, dir } = await createTestService(t, async ({ dir }) => {
    await mkdir(join(dir, 'characters'), { recursive: true })
    await writeFile(join(dir, 'characters', 'aria.json'), CARD, 'utf8')
    return {
      stream,
      broadcast: event => { if (event.type === 'stream.end') ends += 1 },
    }
  }, 'iris-branch-delete-')
  let waited = 0
  const lines = async (chatId: string): Promise<string[]> =>
    (await readFile(join(dir, 'chats', `${chatId}.jsonl`), 'utf8')).trim().split('\n')
  return {
    dir,
    handlers,
    say: async (chatId, text) => {
      await handlers['chat.send']({ chatId, text })
      waited += 1
      while (ends < waited) await new Promise(resolve => setTimeout(resolve, 1))
    },
    lines,
    header: async chatId => JSON.parse((await lines(chatId))[0] ?? '{}') as never,
  }
}

/**
 * root (7 floors) → a (cut at 2, then two of its own) → { c (cut at a's 1), b (cut at a's 4) → d (cut at b's 4) }.
 * @returns the ids.
 */
async function lineage(fix: Fixture): Promise<Record<'root' | 'a' | 'b' | 'c' | 'd', string>> {
  const root = (await fix.handlers['chat.create']({ characterId: 'aria' })).view.chatId
  await fix.say(root, 'q1')
  await fix.say(root, 'q2')
  await fix.say(root, 'q3')
  const a = (await fix.handlers['chat.branch']({ chatId: root, id: 2 })).view.chatId
  await fix.say(a, 'a q')
  const b = (await fix.handlers['chat.branch']({ chatId: a, id: 4 })).view.chatId
  const c = (await fix.handlers['chat.branch']({ chatId: a, id: 1 })).view.chatId
  const d = (await fix.handlers['chat.branch']({ chatId: b, id: 4 })).view.chatId
  return { root, a, b, c, d }
}

/** The graph's invariants after any delete: one root, every parent present, no lane detached. */
function assertWhole(tree: ChatTreeView): void {
  const ids = new Set(tree.chats.map(node => node.chatId))
  assert.equal(tree.chats.filter(node => node.parentChatId === undefined).length, 1, 'exactly one root')
  assert.equal(tree.chats[0]?.chatId, tree.rootChatId)
  for (const node of tree.chats) {
    assert.equal(node.detachedFrom, undefined, `${node.chatId} names a parent that is gone`)
    if (node.parentChatId !== undefined) assert.ok(ids.has(node.parentChatId), `${node.chatId}'s parent is not in the tree`)
  }
}

test('deleting a middle branch re-attaches its children to its parent, with the forks they have there', async (t) => {
  const fix = await fixture(t)
  const { root, a, b, c, d } = await lineage(fix)
  const bBefore = await fix.lines(b)
  const bHeaderBefore = await fix.header(b)
  const rootTitle = (await fix.header(root)).iris['title']

  const answer = await fix.handlers['chat.delete']({ chatId: a })
  assert.deepEqual(answer, { deleted: [a], reattached: [c, b], successor: root })

  const { tree } = await fix.handlers['chat.tree']({ chatId: d })
  assertWhole(tree)
  assert.equal(tree.rootChatId, root)
  assert.deepEqual(tree.chats.map(node => node.chatId), [root, c, b, d])
  const by = new Map(tree.chats.map(node => [node.chatId, node]))
  // c was cut at 1, above a's fork at 2: the cut stands, now on the root.
  assert.equal(by.get(c)?.parentChatId, root)
  assert.deepEqual(by.get(c)?.fork, { floor: 1, shared: 2, source: 'recorded' })
  // b was cut at a's own floor 4: relative to the root it leaves where a left.
  assert.equal(by.get(b)?.parentChatId, root)
  assert.deepEqual(by.get(b)?.fork, { floor: 2, shared: 3, source: 'recorded' })
  assert.equal(by.get(b)?.depth, 1)
  // d is b's child and stays so.
  assert.equal(by.get(d)?.parentChatId, b)
  assert.deepEqual(by.get(d)?.fork, { floor: 4, shared: 5, source: 'recorded' })

  // On disk: the header moved, with upstream's field beside it; nothing else did.
  const bAfter = await fix.lines(b)
  assert.deepEqual(bAfter.slice(1), bBefore.slice(1), 'every floor line of b is the bytes it was')
  const header = await fix.header(b)
  assert.equal(header.iris['parentChatId'], root)
  const rootLine = JSON.parse((await fix.lines(root))[3] ?? '{}') as { iris_id?: string }
  assert.deepEqual(header.iris['branchAt'], { floor: 2, lineId: rootLine.iris_id })
  assert.equal(header.chat_metadata['main_chat'], rootTitle)
  assert.equal(header.iris['updatedAt'], bHeaderBefore.iris['updatedAt'], 'a delete elsewhere is not activity here')

  // The sidebar's rows say the same.
  const { chats } = await fix.handlers['chat.list']({})
  assert.equal(chats.find(row => row.chatId === b)?.parentChatId, root)
  assert.equal(chats.find(row => row.chatId === c)?.parentChatId, root)
  assert.equal(chats.some(row => row.chatId === a), false)
})

test('deleting the root promotes its first child, and the tree stays whole', async (t) => {
  const fix = await fixture(t)
  const root = (await fix.handlers['chat.create']({ characterId: 'aria' })).view.chatId
  await fix.say(root, 'q1')
  await fix.say(root, 'q2')
  const later = (await fix.handlers['chat.branch']({ chatId: root, id: 3 })).view.chatId
  const first = (await fix.handlers['chat.branch']({ chatId: root, id: 1 })).view.chatId

  const answer = await fix.handlers['chat.delete']({ chatId: root })
  assert.deepEqual(answer, { deleted: [root], reattached: [first, later], promoted: first, successor: first })

  const { tree } = await fix.handlers['chat.tree']({ chatId: later })
  assertWhole(tree)
  assert.equal(tree.rootChatId, first)
  assert.deepEqual(tree.chats.find(node => node.chatId === later)?.fork, { floor: 1, shared: 2, source: 'recorded' })
  const promoted = await fix.header(first)
  assert.equal(promoted.iris['parentChatId'], undefined)
  assert.equal(promoted.iris['branchAt'], undefined)
  assert.equal(promoted.chat_metadata['main_chat'], undefined, 'a root names no parent, in either field')
})

test("'delete' removes the branch and its whole subtree, and nothing else", async (t) => {
  const fix = await fixture(t)
  const { root, a, b, c, d } = await lineage(fix)
  const answer = await fix.handlers['chat.delete']({ chatId: a, subBranches: 'delete' })
  assert.deepEqual(answer, { deleted: [a, c, b, d], reattached: [], successor: root })
  const files = (await readdir(join(fix.dir, 'chats'))).filter(name => name.endsWith('.jsonl'))
  assert.deepEqual(files, [`${root}.jsonl`])
  const { tree } = await fix.handlers['chat.tree']({ chatId: root })
  assert.deepEqual(tree.chats.map(node => node.chatId), [root])
})

test('an unknown chat is still refused, and nothing is re-attached for it', async (t) => {
  const fix = await fixture(t)
  await assert.rejects(
    () => fix.handlers['chat.delete']({ chatId: 'nope' }),
    (error: unknown) => (error as { code?: string }).code === 'not-found',
  )
})

test('a rename shows in the list and in the tree', async (t) => {
  const fix = await fixture(t)
  const { a, d } = await lineage(fix)
  const renamed = await fix.handlers['chat.rename']({ chatId: a, title: '雨夜那条线' })
  assert.equal(renamed.chats.find(row => row.chatId === a)?.title, '雨夜那条线')
  const { tree } = await fix.handlers['chat.tree']({ chatId: d })
  assert.equal(tree.chats.find(node => node.chatId === a)?.title, '雨夜那条线')
  // Its children still find it: the link is the id, not the title.
  assert.equal(tree.chats.filter(node => node.parentChatId === a).length, 2)
})
