/**
 * Refused-request notices: one row per (card, frame kind, host, directive),
 * counted exactly, dated first-to-newest, and written to the log at most once
 * per `BLOCKED_NOTICE_FLUSH_MS` (#189's leftover 2: `NoticeLog` re-rendered
 * once per refused-font report, 2,900–4,800 a round in the owner's stall run).
 *
 * Driven through `frameCallbacks(...).onBlocked`, the one road the runner's
 * refusals take, so the key is the one the shell really builds.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { ChatView, IrisClient } from '@iris/protocol'

import { frameCallbacks } from '../src/app/frame-callbacks.ts'
import type { FrameBinding } from '../src/client/card-gateway.ts'
import {
  BLOCKED_NOTICE_FLUSH_MS, NOTICE_LOG_LIMIT, blockedNoticeKey, createIrisStore, foldBlockedNotices,
  type Notice, type PendingBlockedNotice,
} from '../src/client/store.ts'

function store(): ReturnType<typeof createIrisStore> {
  const view: ChatView = { chatId: 'c1', title: 'A scene', messages: [], characterId: 'aria' }
  const client: IrisClient = {
    connected: true,
    onConnectionChange: () => () => undefined,
    subscribe: () => () => undefined,
    async call() { return { view } as never },
  }
  const wired = createIrisStore(client, { transport: 'fake', origin: 'blocked notice test' })
  wired.store.setState({ chatId: 'c1', view })
  return wired
}

const SCRIPT: FrameBinding = { kind: 'script', chatId: 'c1', characterId: 'aria' }
const INTERFACE: FrameBinding = { kind: 'interface', chatId: 'c1', characterId: 'aria' }

test('3,000 interleaved refusals: exact counts per key, first and last times kept, bounded log writes', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 })
  const wired = store()
  let logWrites = 0
  const off = wired.store.subscribe((state, previous) => {
    if (state.noticeLog !== previous.noticeLog) logWrites += 1
  })
  const script = frameCallbacks(wired.store, SCRIPT)
  const iface = frameCallbacks(wired.store, INTERFACE)

  // Three identities, interleaved the way a card's font requests arrive: two
  // hosts from the interface frames, one from the script frame. Interleaving
  // is what defeated the old last-row dedup — no two neighbours matched.
  const REPORTS = 3_000
  const expected = new Map<string, number>()
  const start = Date.now()
  for (let at = 0; at < REPORTS; at += 1) {
    const which = at % 3
    const host = which === 1 ? 'fonts.gstatic.com' : 'fonts.googleapis.com'
    const callbacks = which === 2 ? script : iface
    callbacks.onBlocked(host, 'font-src', `/s/font-${String(at)}.woff2`)
    const key = blockedNoticeKey({ characterId: 'aria', frameKind: which === 2 ? 'script' : 'interface', host, directive: 'font-src' })
    expected.set(key, (expected.get(key) ?? 0) + 1)
    t.mock.timers.tick(1)
  }
  t.mock.timers.tick(BLOCKED_NOTICE_FLUSH_MS)
  const elapsed = Date.now() - start
  off()

  const log = wired.store.getState().noticeLog
  const rows = log.filter(notice => notice.blockKey !== undefined)
  assert.equal(rows.length, 3, 'one row per (card, frame kind, host, directive)')
  for (const row of rows) {
    assert.equal(row.count, expected.get(row.blockKey!), `exact count for ${row.blockKey!}`)
  }
  assert.equal(rows.reduce((sum, row) => sum + (row.count ?? 1), 0), REPORTS, 'every report is counted, none lost to batching')
  const first = rows.find(row => row.blockKey === [...expected.keys()][0])!
  assert.equal(first.firstAt, start, 'the first occurrence time is kept')
  assert.equal(first.at, start + REPORTS - 3, 'the newest occurrence time is the row time')
  assert.match(first.text, /font-2997\.woff2/, 'the row speaks the newest occurrence')
  const bound = Math.ceil(elapsed / BLOCKED_NOTICE_FLUSH_MS) + 1
  assert.ok(logWrites <= bound, `log written ${String(logWrites)} times for ${String(REPORTS)} reports over ${String(elapsed)} ms (bound ${String(bound)})`)
  assert.ok(logWrites >= 1, 'and written at all')
  assert.equal(wired.store.getState().notice?.blockKey !== undefined, true, 'the bar still hears a refusal')
  wired.dispose()
})

test('a burst inside one interval is one write; nothing reaches the log before it ends', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 5_000 })
  const wired = store()
  const iface = frameCallbacks(wired.store, INTERFACE)
  for (let at = 0; at < 500; at += 1) iface.onBlocked('fonts.gstatic.com', 'font-src')
  assert.equal(wired.store.getState().noticeLog.length, 0, 'batched: the log has not moved yet')
  t.mock.timers.tick(BLOCKED_NOTICE_FLUSH_MS)
  const [row] = wired.store.getState().noticeLog
  assert.equal(row?.count, 500)
  // The count keeps rising across flushes, on the same row.
  for (let at = 0; at < 7; at += 1) iface.onBlocked('fonts.gstatic.com', 'font-src')
  t.mock.timers.tick(BLOCKED_NOTICE_FLUSH_MS)
  const log = wired.store.getState().noticeLog
  assert.equal(log.length, 1)
  assert.equal(log[0]?.count, 507)
  assert.equal(log[0]?.firstAt, 5_000, 'first time survives a second flush')
  wired.dispose()
})

test('the fold: a held row is updated where it is and moved last; a row off the front starts again', () => {
  let seq = 100
  const next = (): number => (seq += 1)
  const other: Notice = { kind: 'error', text: 'unrelated', seq: 1, at: 10 }
  const held: Notice = { kind: 'info', text: 'blocked a (font-src)', seq: 2, at: 20, blockKey: 'k' }
  const pending = new Map<string, PendingBlockedNotice>([['k', { text: 'blocked a/x (font-src)', count: 4, firstAt: 30, lastAt: 40 }]])
  const folded = foldBlockedNotices([held, other], pending, next)
  assert.deepEqual(folded.log.map(row => row.text), ['unrelated', 'blocked a/x (font-src)'])
  assert.equal(folded.log[1]?.count, 5, 'held 1 + batch 4')
  assert.equal(folded.log[1]?.firstAt, 20, 'first time is the held row’s')
  assert.equal(folded.log[1]?.at, 40)
  assert.equal(folded.dropped, 0)

  const full: Notice[] = Array.from({ length: NOTICE_LOG_LIMIT }, (_, at) => ({ kind: 'info', text: `n${String(at)}`, seq: at, at }))
  const single = new Map<string, PendingBlockedNotice>([['z', { text: 'blocked z', count: 1, firstAt: 9, lastAt: 9 }]])
  const overflow = foldBlockedNotices(full, single, next)
  assert.equal(overflow.log.length, NOTICE_LOG_LIMIT)
  assert.equal(overflow.dropped, 1, 'the drop is counted')
  assert.equal(overflow.log.at(-1)?.count, undefined, 'a single occurrence stands for itself')
  assert.equal(overflow.log.at(-1)?.firstAt, undefined)
})
