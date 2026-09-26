/**
 * How often `NoticeLog` renders under a flood of refused requests, counted by
 * React's own `Profiler` on the real component and the real store.
 *
 * Mounted by `notice-log-render-mount.test.ts` under jsdom through Vite's SSR
 * loader. The flood is spread over real time — batches of reports with a
 * short pause between — because a synchronous burst would be one render
 * under any implementation and prove nothing about the rate.
 */
import { Profiler, act } from 'react'
import { createRoot } from 'react-dom/client'
import type { ChatView, IrisClient } from '@iris/protocol'
import { NoticeLog } from '../src/app/NoticeLog.tsx'
import { frameCallbacks } from '../src/app/frame-callbacks.ts'
import { StoreProvider } from '../src/client/provider.tsx'
import { BLOCKED_NOTICE_FLUSH_MS, createIrisStore } from '../src/client/store.ts'

const pause = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

/** What the flood did. */
export interface FloodResult {
  reports: number
  renders: number
  elapsedMs: number
  counted: number
  rows: number
  shownCount: string | undefined
}

/**
 * Mount the log, send `reports` refusals over about `spanMs`, count renders.
 * @param container - where to mount.
 * @param reports - how many refusals.
 * @param spanMs - over how long.
 * @returns the counts.
 */
export async function flood(container: HTMLElement, reports: number, spanMs: number): Promise<FloodResult> {
  const view: ChatView = { chatId: 'c1', title: 'A scene', messages: [], characterId: 'aria' }
  const client: IrisClient = {
    connected: true,
    onConnectionChange: () => () => undefined,
    subscribe: () => () => undefined,
    async call() { return { view } as never },
  }
  const wired = createIrisStore(client, { transport: 'fake', origin: 'notice log render test' })
  wired.store.setState({ chatId: 'c1', view })
  const callbacks = frameCallbacks(wired.store, { kind: 'interface', chatId: 'c1', characterId: 'aria' })
  let renders = 0
  const root = createRoot(container)
  try {
    await act(async () => root.render(
      <StoreProvider store={wired.store}>
        <Profiler id="notice-log" onRender={() => { renders += 1 }}><NoticeLog /></Profiler>
      </StoreProvider>,
    ))
    renders = 0
    const slices = 40
    const per = Math.ceil(reports / slices)
    const started = Date.now()
    let sent = 0
    for (let slice = 0; slice < slices && sent < reports; slice += 1) {
      await act(async () => {
        for (let at = 0; at < per && sent < reports; at += 1, sent += 1) {
          callbacks.onBlocked(sent % 2 === 0 ? 'fonts.googleapis.com' : 'fonts.gstatic.com', 'font-src', `/f/${String(sent)}.woff2`)
        }
        await pause(spanMs / slices)
      })
    }
    await act(async () => { await pause(BLOCKED_NOTICE_FLUSH_MS * 2) })
    const elapsedMs = Date.now() - started
    const log = wired.store.getState().noticeLog
    return {
      reports: sent,
      renders,
      elapsedMs,
      counted: log.reduce((sum, row) => sum + (row.count ?? 1), 0),
      rows: log.length,
      shownCount: container.querySelector('.iris-notices__times')?.textContent ?? undefined,
    }
  } finally {
    await act(async () => root.unmount())
    wired.dispose()
  }
}
