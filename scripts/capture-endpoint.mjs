#!/usr/bin/env node
/**
 * A loopback OpenAI-compatible endpoint that records requests instead of
 * answering them.
 *
 * Point SillyTavern's Chat Completion source at `custom` with this URL and send
 * one message. What lands on disk is **SillyTavern's own request body**, byte
 * for byte, for whatever card / preset / conversation was open — the only
 * artefact that can settle an argument about what a preset does, because it is
 * the thing the model would have been given.
 *
 * Why a fake endpoint rather than reading SillyTavern's code: the request is the
 * product of ~100 settings fields, two macro passes, a world-info scan, a token
 * budget and three tiers of regex. Every one of those is a place a reimplementation
 * can diverge, and only the final body knows whether it did.
 *
 * Answers with a fixed, minimal SSE stream so the client does not hang or retry:
 * one content delta, one `finish_reason`, `[DONE]`. Nothing is forwarded
 * anywhere — this process makes no outbound connections at all.
 *
 * Usage:
 *
 *   node scripts/capture-endpoint.mjs --out cap/st --port 8899
 *   node scripts/capture-endpoint.mjs --out cap/st --reply "ok."
 *
 * Then in SillyTavern: API `Chat Completion`, source `Custom (OpenAI-compatible)`,
 * endpoint `http://127.0.0.1:8899/v1`, any non-empty key, and click Connect.
 * `notes/packages/iris-preset/PARITY-HOWTO.md` has the full walk-through.
 *
 * @module scripts/capture-endpoint
 */

import { createServer } from 'node:http'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Loopback only. A capture endpoint that answered the network would be a proxy. */
const HOST = '127.0.0.1'

/** How much of one body to accept, so a stray upload cannot exhaust memory. */
const MAX_BODY_BYTES = 64 * 1024 * 1024

/**
 * Parse `--flag value` arguments.
 * @param argv - `process.argv.slice(2)`.
 * @returns the flags, as strings.
 */
function parseArgs(argv) {
  const args = {}
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) continue
    const name = token.slice(2)
    const next = argv[index + 1]
    if (next === undefined || next.startsWith('--')) args[name] = 'true'
    else {
      args[name] = next
      index += 1
    }
  }
  return args
}

/**
 * A filename-safe, sortable timestamp: `20260908-143012-004`.
 * @param at - the moment to stamp.
 * @returns the stamp.
 */
function stamp(at) {
  const pad = (value, width) => String(value).padStart(width, '0')
  return `${String(at.getUTCFullYear())}${pad(at.getUTCMonth() + 1, 2)}${pad(at.getUTCDate(), 2)}`
    + `-${pad(at.getUTCHours(), 2)}${pad(at.getUTCMinutes(), 2)}${pad(at.getUTCSeconds(), 2)}`
    + `-${pad(at.getUTCMilliseconds(), 3)}`
}

/**
 * Read a whole request body, refusing one that is too large.
 * @param request - the incoming request.
 * @returns the raw bytes.
 * @throws {Error} when the body exceeds {@link MAX_BODY_BYTES}.
 */
async function readBody(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new Error(`request body over ${String(MAX_BODY_BYTES)} bytes`)
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

/**
 * The SSE frames one capture answers with.
 *
 * Deliberately minimal and deliberately identical every time: the reply is not
 * the artefact, and a reply that varied would make two captures of the same
 * request look different in the client's own log.
 * @param reply - the single content delta to emit.
 * @returns the full response body.
 */
function sseReply(reply) {
  const base = { id: 'capture', object: 'chat.completion.chunk', created: 0, model: 'capture' }
  const frame = value => `data: ${JSON.stringify(value)}\n\n`
  return frame({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: reply }, finish_reason: null }] })
    + frame({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
    + 'data: [DONE]\n\n'
}

/**
 * Start the capture endpoint.
 * @param options - output directory, port and canned reply.
 * @returns the listening server, and the resolved output directory.
 */
export async function startCapture(options = {}) {
  const dir = resolve(options.out ?? 'capture')
  const port = Number(options.port ?? 8899)
  const reply = options.reply ?? 'captured.'
  await mkdir(dir, { recursive: true })

  let count = 0
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', `http://${HOST}`)
      const path = url.pathname.replace(/\/+$/, '') || '/'

      // The model list, so the client's own connection check passes and the
      // model dropdown is populated. Named after the endpoint so a user reading
      // SillyTavern's model select can see which server answered.
      if (request.method === 'GET' && path.endsWith('/models')) {
        const body = JSON.stringify({
          object: 'list',
          data: [{ id: 'iris-capture', object: 'model', created: 0, owned_by: 'iris' }],
        })
        response.writeHead(200, { 'content-type': 'application/json' }).end(body)
        return
      }

      if (request.method !== 'POST' || !path.endsWith('/chat/completions')) {
        response.writeHead(404, { 'content-type': 'application/json' })
          .end(JSON.stringify({ error: { message: `no route for ${request.method ?? '?'} ${path}` } }))
        return
      }

      let raw
      try {
        raw = await readBody(request)
      } catch (error) {
        response.writeHead(413, { 'content-type': 'application/json' })
          .end(JSON.stringify({ error: { message: String(error) } }))
        return
      }

      count += 1
      const name = `${stamp(new Date())}-${String(count).padStart(3, '0')}.json`
      // Written verbatim, before any parse: the artefact is the bytes the client
      // sent. A pretty-printed re-serialisation would already have lost key
      // order, and key order is exactly what a byte-level comparison reads.
      await writeFile(join(dir, name), raw)

      let summary = '(unparseable JSON)'
      try {
        const body = JSON.parse(raw.toString('utf8'))
        const messages = Array.isArray(body.messages) ? body.messages : []
        const roles = messages.map(message => String(message.role ?? '?')[0]).join('')
        summary = `${String(messages.length)} messages [${roles}] model=${String(body.model)}`
          + ` max_tokens=${String(body.max_tokens)} temp=${String(body.temperature)}`
      } catch { /* the file is still the artefact */ }
      process.stdout.write(`captured ${name}  ${String(raw.length)} bytes  ${summary}\n`)

      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      }).end(sseReply(reply))
    })()
  })

  await new Promise((done, fail) => {
    server.once('error', fail)
    server.listen(port, HOST, () => { done(undefined) })
  })
  return { server, dir, port }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2))
  const { dir, port } = await startCapture(args)
  process.stdout.write(
    `capture endpoint listening on http://${HOST}:${String(port)}/v1\n`
    + `writing request bodies to ${dir}\n`
    + 'in SillyTavern: Chat Completion -> Custom (OpenAI-compatible),'
    + ` endpoint http://${HOST}:${String(port)}/v1, any non-empty key\n`,
  )
}
