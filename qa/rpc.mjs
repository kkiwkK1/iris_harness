/**
 * Shared helpers for the QA scripts: JSON-RPC over the Iris transport and an
 * event collector over `/iris/events`.
 *
 * QA-only tooling for the six-card regression on dev/qa-6cards. Lives outside
 * `apps/` and `packages/` on purpose: it drives a live host over the wire and
 * is not part of any build.
 */

export const BASE = process.env.IRIS_BASE ?? 'http://127.0.0.1:8792'

let seq = 0

/** One RPC call. Returns the full frame (`{id, ok, result|error}`). */
export async function rpc(method, params = {}) {
  const res = await fetch(new URL('/iris/rpc', BASE), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: `qa-${++seq}`, method, params }),
  })
  if (!res.ok) throw new Error(`${method}: HTTP ${res.status}`)
  return res.json()
}

/** One RPC call that throws on a named error frame. */
export async function call(method, params = {}) {
  const frame = await rpc(method, params)
  if (frame.ok === false) {
    const err = new Error(`${method}: ${frame.error?.code ?? '?'} ${frame.error?.message ?? ''}`)
    err.code = frame.error?.code
    err.messageText = frame.error?.message
    throw err
  }
  return frame.result
}

/** Collect live events for a chat until a predicate fires or time runs out. */
export function eventWatcher(filter = {}) {
  const wsBase = BASE.replace(/^http/, 'ws')
  const ws = new WebSocket(new URL('/iris/events', wsBase))
  const events = []
  const ready = new Promise((resolve, reject) => {
    ws.onopen = resolve
    ws.onerror = () => reject(new Error('event socket failed'))
  })
  ws.onmessage = m => {
    try {
      const e = JSON.parse(m.data)
      if (filter.chatId === undefined || e.chatId === filter.chatId) events.push(e)
    } catch { /* ignore malformed lines */ }
  }
  const waitUntil = async (predicate, timeoutMs) => {
    await ready
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      const hit = events.find(predicate)
      if (hit !== undefined) return hit
      await new Promise(r => setTimeout(r, 200))
    }
    return undefined
  }
  const close = () => ws.close()
  return { events, waitUntil, close, ready }
}

/** Read the host's retained diagnostic reports. */
export async function debugReports() {
  const frame = await rpc('debug.reports', {})
  if (frame.ok === false) return { reports: [], dropped: 0, error: frame.error }
  return frame.result
}
