/**
 * What a reconnect does to a frame run, counted on the real store and the real
 * runtime hook.
 *
 * Mounted by `reconnect-frame-runtime-mount.test.ts` under jsdom through Vite's
 * SSR loader (the hook reads the store through `provider.tsx`). The probe is a
 * stand-in frame owner: one effect keyed on `usePluginFrameRuntime().key`,
 * exactly as `useCardScripts` and `MessageInterfaces` key their runs, counting
 * how many runs it started and how many it tore down. The shell's real frames
 * are counted as iframes by `qa/reconnect-no-rebuild-acceptance.mjs`.
 */
import assert from 'node:assert/strict'
import { act, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import type { ChatView, IrisClient, SystemPluginSnapshot } from '@iris/protocol'
import { StoreProvider } from '../src/client/provider.tsx'
import { createIrisStore } from '../src/client/store.ts'
import { usePluginFrameRuntime } from '../src/app/plugin-frame-runtime.ts'

function snapshot(revision: number, mvu = true): SystemPluginSnapshot {
  const row = (id: string, enabled: boolean): SystemPluginSnapshot['plugins'][number] => ({
    id, name: id, description: '', version: '1.0.0', apiVersion: 1, dependencies: [],
    installed: true, enabled, status: enabled ? 'enabled' : 'disabled',
  })
  return { revision, plugins: [row('tavern-helper', true), row('mvu', mvu), row('demo', true)] }
}

function manifest(revision: number, rev: string): string {
  return JSON.stringify({ revision, plugins: { demo: { rev, client: `/plugins/demo/client.js?rev=${rev}` } } })
}

/** A client whose `plugin.list` answer and connection the test controls. */
function controlled(initial: SystemPluginSnapshot): {
  client: IrisClient
  setListed: (next: SystemPluginSnapshot | Error) => void
  reconnect: () => void
  release: () => void
} {
  let listed: SystemPluginSnapshot | Error = initial
  /*
   * Every list after boot waits for the test to release it. A real reconnect
   * has a round trip between the socket opening and the list answering, and
   * the page renders in between — which is exactly when a cleared snapshot
   * tore the runs down. Answered at once, React would batch the gap away.
   */
  let held = false
  const waiting: Array<() => void> = []
  const connection = new Set<(connected: boolean) => void>()
  const view: ChatView = { chatId: 'unused', title: 'unused', messages: [] }
  const client: IrisClient = {
    connected: true,
    subscribe: () => () => undefined,
    onConnectionChange(listener) {
      connection.add(listener)
      return () => { connection.delete(listener) }
    },
    async call(method) {
      if (method === 'plugin.list') {
        if (held) await new Promise<void>(resolve => { waiting.push(resolve) })
        held = true
        if (listed instanceof Error) throw listed
        // A fresh object per answer, as the wire gives: identity never matches.
        return structuredClone(listed) as never
      }
      if (method === 'chat.list') return { chats: [] } as never
      if (method === 'character.list') return { characters: [] } as never
      if (method === 'settings.get') return { settings: { provider: 'p', model: 'm' } } as never
      if (method === 'connection.list') return { profiles: [] } as never
      return { view } as never
    },
  }
  return {
    client,
    setListed: next => { listed = next },
    reconnect: () => {
      connection.forEach(listener => listener(false))
      connection.forEach(listener => listener(true))
    },
    release: () => { waiting.splice(0).forEach(resolve => resolve()) },
  }
}

const pause = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

/** Run counts after each step, for the test to assert and the PR to quote. */
export interface ReconnectCounts {
  started: number
  disposed: number
  manifestReads: number
  key: string | undefined
}

/**
 * Boot, then reconnect four ways, returning the counts after each.
 * @param container - where to mount.
 * @param setManifestBody - what the next manifest fetch answers.
 * @param manifestReads - how many manifest fetches have been made.
 */
export async function checkReconnect(
  container: HTMLElement,
  setManifestBody: (body: string) => void,
  manifestReads: () => number,
): Promise<Record<'boot' | 'identical' | 'identicalAgain' | 'bundleChanged' | 'revisionChanged' | 'listFailed', ReconnectCounts>> {
  setManifestBody(manifest(5, 'aaaaaaaaaaaa'))
  const host = controlled(snapshot(5))
  const wired = createIrisStore(host.client, { transport: 'fake', origin: 'reconnect frame runtime test' })
  let started = 0
  let disposed = 0
  let key: string | undefined
  function FrameOwner(): null {
    const runtime = usePluginFrameRuntime()
    key = runtime.key
    useEffect(() => {
      if (runtime.key === undefined) return undefined
      started += 1
      return () => { disposed += 1 }
    }, [runtime.key])
    return null
  }
  const root = createRoot(container)
  const read = (): ReconnectCounts => ({ started, disposed, manifestReads: manifestReads(), key })
  const step = async (work: () => void): Promise<ReconnectCounts> => {
    await act(async () => {
      work()
      await pause(20)
    })
    // The page renders the gap, then the list answers.
    await act(async () => {
      host.release()
      await pause(20)
    })
    await act(async () => { await pause(20) })
    return read()
  }
  try {
    await act(async () => root.render(<StoreProvider store={wired.store}><FrameOwner /></StoreProvider>))
    const boot = await step(() => { void wired.store.getState().boot() })
    assert.equal(wired.store.getState().systemPlugins?.revision, 5, 'boot adopted the catalog')
    assert.ok(boot.key?.includes('aaaaaaaaaaaa'), `the run is built with the manifest row: ${String(boot.key)}`)

    const identical = await step(() => { host.reconnect() })
    const identicalAgain = await step(() => { host.reconnect() })

    // Same revision, same rows, a different client bundle: only a restarted
    // host serves this, and only the per-session manifest read can see it.
    setManifestBody(manifest(5, 'bbbbbbbbbbbb'))
    const bundleChanged = await step(() => { host.reconnect() })

    host.setListed(snapshot(9, false))
    setManifestBody(manifest(9, 'bbbbbbbbbbbb'))
    const revisionChanged = await step(() => { host.reconnect() })

    host.setListed(new Error('host refused plugin.list'))
    const listFailed = await step(() => { host.reconnect() })
    return { boot, identical, identicalAgain, bundleChanged, revisionChanged, listFailed }
  } finally {
    await act(async () => root.unmount())
    wired.dispose()
  }
}
